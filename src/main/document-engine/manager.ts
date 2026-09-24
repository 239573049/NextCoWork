/**
 * 文档会话管理器 —— 「同一个文档只有一个活动模型」这条不变式的唯一持有者。
 *
 * ## 为了什么需求建的
 *
 * 办公插件要求编辑器画布与 Agent 工具操作**同一个**活动文档:用户正在打字的
 * 未保存内容,Agent 的修改必须叠在它上面,而不是另开一份、改完覆盖回磁盘。
 * 做到这一点只能让所有修改(UI 输入、Agent 批次、宏、保存)进入**同一个会话的
 * 同一条串行队列**,并由一个地方记账修订号。这个类就是那个地方。
 *
 * ## 它拥有 / 不拥有什么
 *
 * - 拥有:会话身份与去重、调用方作用域、串行队列、修订号与保存状态、操作回执
 *   (含「结果未知」)、私有工作副本的生命周期。
 * - 不拥有:文档语义。排版、计算、对象模型全在引擎 provider 里(插件携带的
 *   LibreOffice helper);这里只认 `DocumentEngineProvider` 接口,于是能用
 *   fake provider 在无头 Node 里把全部账目测到(计划 §12 B)。
 * - 不做远程:传进来的是**本机绝对路径**。SSH 工作区的回写 / 租约没有实现,
 *   调用方必须在进来之前拒绝(返回 `unsupported_environment`),不能静默退回本地。
 * - 不做崩溃快照恢复:`reloadFromDisk` 只能回到上次**已保存**的内容,未保存改动会丢,
 *   这一点在返回值里如实体现(dirty=false、generation+1)。恢复快照(计划 §5
 *   `recovery.ts`)接上之前,不许把这条路叫做「恢复」。
 *
 * ## 不依赖 electron
 *
 * 只用 node:fs 与纯函数,和 `kernel/**` 同一立场:无头测试能直接构造它。
 */
import { randomUUID } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DocumentEngineError,
  documentFormatOf,
  validateOperations,
  validateQuery,
  type DocumentApplyResult,
  type DocumentCapabilities,
  type DocumentFormat,
  type DocumentOperation,
  type DocumentQuery
} from '../../shared/document-engine/protocol'
import {
  applyPrecondition,
  initialSession,
  isSessionDirty,
  reduceSession,
  type DocumentSessionEvent,
  type DocumentSessionSnapshot
} from '../../shared/document-engine/session'
import { commitSave, createWorkingCopy } from './file-store'

/** 引擎打开的一份文档。实现方是原生 helper 的适配层(或测试里的 fake)。 */
export interface DocumentEngineHandle {
  readonly capabilities: DocumentCapabilities
  apply(operations: DocumentOperation[], signal: AbortSignal): Promise<{ warnings: string[]; undoable: boolean }>
  /** 把当前模型写到核心给出的路径。★ 路径由核心决定,引擎不能自选保存位置 */
  saveTo(outputPath: string, signal: AbortSignal): Promise<void>
  /** 只读查询。可选:不支持查询的引擎不实现它,管理器如实报 `unsupported_operation` */
  query?(request: DocumentQuery, signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

export interface DocumentEngineProvider {
  /** `<pluginId>/<engineId>`,与清单里 `customEditors[].documentEngine` 的写法一致 */
  readonly id: string
  readonly formats: readonly DocumentFormat[]
  open(
    input: { workingPath: string; format: DocumentFormat; onCrash: () => void },
    signal: AbortSignal
  ): Promise<DocumentEngineHandle>
}

export interface DocumentSessionManagerOptions {
  /** 账户私有目录。工作副本与保存产物只落在这里 */
  privateDir: string
  /** 单次引擎调用的超时。超时的修改记为「结果未知」 */
  timeoutMs?: number
  resolveRealPath?: (path: string) => Promise<string>
  newId?: () => string
  onChange?: (snapshot: DocumentSessionSnapshot) => void
}

/** 调用方作用域。★ 由核心从受信上下文派生(Tab 绑定 / 工具调用 token),不是模型传的 */
export interface DocumentCallerScope {
  accountScope: string
  workspaceId: string
}

export type OperationRecord =
  | { status: 'applied'; sessionId: string; result: DocumentApplyResult }
  | { status: 'rejected'; sessionId: string; code: string }
  | { status: 'unknown'; sessionId: string }

interface Session {
  snapshot: DocumentSessionSnapshot
  key: string
  accountScope: string
  workspaceIds: Set<string>
  absolutePath: string
  providerId: string
  handle: DocumentEngineHandle | null
  workingDir: string
  views: Set<string>
  queue: Promise<unknown>
  /** 首次打开完成(成功或失败)时 settle。并发打开同一文件的第二个调用方等它 */
  loading: Promise<void>
}

const DEFAULT_TIMEOUT_MS = 60_000
/** 回执表上限。★ 不设上限的话一个长会话里 Agent 每次调用都留一条,永不释放 */
const MAX_OPERATION_RECORDS = 2000

function isClosed(session: Session): boolean {
  return session.snapshot.status === 'closed'
}

export class DocumentSessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly byKey = new Map<string, string>()
  private readonly providers = new Map<string, DocumentEngineProvider>()
  private readonly operations = new Map<string, OperationRecord>()
  private readonly timeoutMs: number
  private readonly resolveRealPath: (path: string) => Promise<string>
  private readonly newId: () => string

  constructor(private readonly options: DocumentSessionManagerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.resolveRealPath = options.resolveRealPath ?? realpath
    this.newId = options.newId ?? randomUUID
  }

  /** 登记一个已安装、已批准、版本匹配的引擎。返回撤销函数(插件禁用 / 卸载时调) */
  registerProvider(provider: DocumentEngineProvider): () => void {
    this.providers.set(provider.id, provider)
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id) }
  }

  /**
   * 打开(或加入)一个文档会话,返回快照与一个新的 viewId。
   *
   * ★ 按「账户 + realpath」去重:同一个文件经两个工作区、或者经两个 Tab 打开时,
   * 拿到的是**同一个**会话。两份独立模型各自保存,后存的会把先存的静默覆盖。
   */
  async open(input: { scope: DocumentCallerScope; absolutePath: string; providerId: string }): Promise<{
    snapshot: DocumentSessionSnapshot
    capabilities: DocumentCapabilities
    viewId: string
  }> {
    const format = documentFormatOf(input.absolutePath)
    if (format === null) throw new DocumentEngineError('unsupported_format', 'this file type is not handled by document engines')
    const provider = this.providers.get(input.providerId)
    if (provider === undefined) throw new DocumentEngineError('engine_unavailable', `document engine ${input.providerId} is not installed or not enabled`)
    if (!provider.formats.includes(format)) throw new DocumentEngineError('unsupported_format', `${input.providerId} does not open .${format}`)

    const real = await this.resolveRealPath(input.absolutePath).catch(() => {
      throw new DocumentEngineError('io', 'document does not exist')
    })
    const key = `${input.scope.accountScope}\0${real}`
    const existingId = this.byKey.get(key)
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId)
      if (existing !== undefined && existing.snapshot.status !== 'closed') {
        // 同一个文件被另一个引擎打开是配置错误,不能悄悄换引擎
        if (existing.providerId !== input.providerId) {
          throw new DocumentEngineError('engine_unavailable', 'this document is already open in another document engine')
        }
        existing.workspaceIds.add(input.scope.workspaceId)
        /*
          ★ 先等首次打开完成再加视图。首个打开者还在复制 / 起引擎时,第二个 Tab
          立刻报「引擎不可用」会被用户理解成插件坏了;而先加视图再报错会泄漏一个
          永远不会被 release 的 viewId,于是这个会话再也关不掉。
        */
        await existing.loading
        // ★ 经函数读一次:await 期间状态可能已变成 closed,TS 的窄化不会跟着失效
        if (existing.handle === null || isClosed(existing)) {
          throw new DocumentEngineError('engine_unavailable', 'the document engine stopped while opening')
        }
        const viewId = this.newId()
        existing.views.add(viewId)
        return { snapshot: existing.snapshot, capabilities: existing.handle.capabilities, viewId }
      }
    }

    const sessionId = this.newId()
    let settle: () => void = () => undefined
    const session: Session = {
      snapshot: initialSession(sessionId, format),
      key,
      accountScope: input.scope.accountScope,
      workspaceIds: new Set([input.scope.workspaceId]),
      absolutePath: input.absolutePath,
      providerId: input.providerId,
      handle: null,
      workingDir: join(this.options.privateDir, sessionId),
      views: new Set(),
      queue: Promise.resolve(),
      loading: new Promise<void>((resolve) => { settle = resolve })
    }
    this.sessions.set(sessionId, session)
    this.byKey.set(key, sessionId)
    try {
      const { workingPath, diskRevision } = await createWorkingCopy(input.absolutePath, session.workingDir)
      session.handle = await this.withTimeout((signal) =>
        provider.open({ workingPath, format, onCrash: () => { this.markCrashed(session) } }, signal)
      )
      this.dispatch(session, { type: 'loaded', diskRevision })
    } catch (error) {
      // 打开失败不留半个会话:否则同一文件再开一次会命中一个永远 loading 的条目
      this.sessions.delete(sessionId)
      if (this.byKey.get(key) === sessionId) this.byKey.delete(key)
      session.snapshot = reduceSession(session.snapshot, { type: 'closed' })
      await rm(session.workingDir, { recursive: true, force: true })
      throw error
    } finally {
      settle()
    }
    const viewId = this.newId()
    session.views.add(viewId)
    return { snapshot: session.snapshot, capabilities: session.handle.capabilities, viewId }
  }

  snapshot(sessionId: string, scope: DocumentCallerScope): DocumentSessionSnapshot {
    return this.require(sessionId, scope).snapshot
  }

  capabilities(sessionId: string, scope: DocumentCallerScope): DocumentCapabilities {
    const session = this.require(sessionId, scope)
    if (session.handle === null) throw new DocumentEngineError('engine_unavailable', 'the document engine is not running')
    return session.handle.capabilities
  }

  getOperation(operationId: string): OperationRecord | undefined {
    return this.operations.get(operationId)
  }

  /**
   * 提交一批修改。进串行队列,按 generation / modelRevision 校验前置条件。
   *
   * ★ 同一个 `operationId` 再提交:已生效 → 原样返回上次回执(幂等);结果未知 →
   * 继续报 `result_unknown`。**绝不重放** —— 重放一次「追加段落」就是追加了两段。
   */
  apply(input: {
    sessionId: string
    scope: DocumentCallerScope
    operationId: string
    generation: number
    modelRevision: number
    operations: unknown
  }): Promise<DocumentApplyResult> {
    const session = this.require(input.sessionId, input.scope)
    if (input.operationId === '' || input.operationId.length > 128) {
      return Promise.reject(new DocumentEngineError('invalid_operation', 'operationId is required'))
    }
    const previous = this.operations.get(input.operationId)
    if (previous !== undefined) {
      if (previous.sessionId !== session.snapshot.sessionId) return Promise.reject(new DocumentEngineError('invalid_operation', 'operationId belongs to another document'))
      if (previous.status === 'applied') return Promise.resolve(previous.result)
      if (previous.status === 'unknown') return Promise.reject(new DocumentEngineError('result_unknown', 'this operation may or may not have been applied; read the document state before retrying with a new operationId'))
      return Promise.reject(new DocumentEngineError('invalid_operation', `this operationId was already rejected (${previous.code}); use a new one`))
    }
    return this.enqueue(session, async () => {
      const handle = session.handle
      const blocked = applyPrecondition(session.snapshot, { generation: input.generation, modelRevision: input.modelRevision })
      if (blocked !== null || handle === null) {
        const code = blocked ?? 'engine_unavailable'
        this.record(input.operationId, { status: 'rejected', sessionId: session.snapshot.sessionId, code })
        throw new DocumentEngineError(code, `cannot apply: ${code}`)
      }
      const validated = validateOperations(input.operations, handle.capabilities)
      if (!validated.ok) {
        const code = validated.reason.includes('unsupported_operation') ? 'unsupported_operation' : 'invalid_operation'
        this.record(input.operationId, { status: 'rejected', sessionId: session.snapshot.sessionId, code })
        throw new DocumentEngineError(code, validated.reason)
      }
      /*
        ★ 操作里的语义引用也要核 generation,不只是批次头上那一个:批次头是调用方
        「以为」的 generation,而引用是它当初查询时拿到的。两者都要等于当前 generation,
        否则引擎重启后一个旧引用会指到新模型里另一个碰巧同 id 的对象上。
      */
      const staleRef = validated.operations.find((op) => 'target' in op && op.target.generation !== session.snapshot.generation)
      if (staleRef !== undefined) {
        this.record(input.operationId, { status: 'rejected', sessionId: session.snapshot.sessionId, code: 'stale_generation' })
        throw new DocumentEngineError('stale_generation', 'an operation target comes from an older engine generation; query the document again')
      }
      let outcome: { warnings: string[]; undoable: boolean }
      try {
        outcome = await this.withTimeout((signal) => handle.apply(validated.operations, signal))
      } catch (error) {
        /*
          ★ 引擎没有给出明确「未生效」的拒绝(`invalid_operation` / `unsupported_operation`)
          时,一律按**结果未知**处理并把会话标为崩溃:超时或 helper 中途退出之后,
          模型可能已经改了一半。继续在上面叠修改,修订号就和真实内容对不上了。
        */
        if (error instanceof DocumentEngineError && (error.code === 'invalid_operation' || error.code === 'unsupported_operation')) {
          this.record(input.operationId, { status: 'rejected', sessionId: session.snapshot.sessionId, code: error.code })
          throw error
        }
        this.record(input.operationId, { status: 'unknown', sessionId: session.snapshot.sessionId })
        this.markCrashed(session)
        throw new DocumentEngineError('result_unknown', `the engine did not confirm the operation: ${(error as Error).message}`)
      }
      const revision = session.snapshot.modelRevision + 1
      this.dispatch(session, { type: 'applied', revision })
      const result: DocumentApplyResult = {
        operationId: input.operationId,
        appliedRevision: revision,
        dirty: isSessionDirty(session.snapshot),
        warnings: outcome.warnings,
        undoable: outcome.undoable
      }
      this.record(input.operationId, { status: 'applied', sessionId: session.snapshot.sessionId, result })
      return result
    })
  }

  /**
   * 只读查询(大纲 / 正文 / 单元格区域)。进同一条串行队列:查询读到的必须是
   * 它前面那些修改**之后**的状态,否则 Agent 会拿着过期内容去构造下一批修改。
   *
   * ★ 查询超时同样把会话标为崩溃:引擎连只读都答不上来,继续往里塞修改只会得到更多
   * 「结果未知」。
   */
  query(input: { sessionId: string; scope: DocumentCallerScope; request: unknown }): Promise<{ generation: number; modelRevision: number; result: unknown }> {
    const session = this.require(input.sessionId, input.scope)
    const request = validateQuery(input.request)
    if (typeof request === 'string') return Promise.reject(new DocumentEngineError('invalid_operation', request))
    return this.enqueue(session, async () => {
      const handle = session.handle
      if (session.snapshot.status === 'crashed' || session.snapshot.status === 'recovering' || handle === null) {
        throw new DocumentEngineError('engine_unavailable', `cannot query while ${session.snapshot.status}`)
      }
      if (handle.query === undefined) throw new DocumentEngineError('unsupported_operation', 'this document engine does not support queries')
      const query = handle.query.bind(handle)
      try {
        const result = await this.withTimeout((signal) => query(request, signal))
        return { generation: session.snapshot.generation, modelRevision: session.snapshot.modelRevision, result }
      } catch (error) {
        if (error instanceof DocumentEngineError && (error.code === 'invalid_operation' || error.code === 'unsupported_operation')) throw error
        this.markCrashed(session)
        throw error
      }
    })
  }

  /**
   * 保存到原文件。冲突(盘上被别人改过)进入 `conflict`,**不覆盖**。
   * 没有修改时是 no-op,不顶 mtime。
   */
  save(input: { sessionId: string; scope: DocumentCallerScope }): Promise<DocumentSessionSnapshot> {
    const session = this.require(input.sessionId, input.scope)
    return this.enqueue(session, async () => {
      const handle = session.handle
      const status = session.snapshot.status
      if (status === 'conflict') throw new DocumentEngineError('disk_conflict', 'resolve the disk conflict before saving')
      if (status !== 'ready' || handle === null) throw new DocumentEngineError('engine_unavailable', `cannot save while ${status}`)
      /*
        ★ 引擎说不能存就不存:PDF 经 LibreOffice Draw 导入,「保存」会整份重写 PDF
        (字体子集、结构、签名都可能变),那不是用户以为的「保存」。
      */
      if (!handle.capabilities.canSave) throw new DocumentEngineError('unsupported_operation', 'this document engine cannot save this format in place')
      if (!isSessionDirty(session.snapshot)) return session.snapshot
      const savedModelRevision = session.snapshot.modelRevision
      this.dispatch(session, { type: 'saveStarted' })
      const produced = join(session.workingDir, `save-${this.newId()}.${session.snapshot.format}`)
      try {
        await this.withTimeout((signal) => handle.saveTo(produced, signal))
        const diskRevision = await commitSave(session.absolutePath, produced, session.snapshot.diskRevision)
        this.dispatch(session, { type: 'saved', diskRevision, savedModelRevision })
        return session.snapshot
      } catch (error) {
        if (error instanceof DocumentEngineError && error.code === 'disk_conflict') this.dispatch(session, { type: 'diskConflict' })
        else this.dispatch(session, { type: 'saveFailed' })
        throw error
      } finally {
        await rm(produced, { force: true })
      }
    })
  }

  /**
   * 丢弃活动模型、从盘上重新读取。用于引擎崩溃之后,或用户在冲突时选择「采用磁盘版本」。
   *
   * ★ 未保存的改动**会丢**(恢复快照还没有实现,见文件头)。generation +1,
   * 旧引用全部失效。
   */
  reloadFromDisk(input: { sessionId: string; scope: DocumentCallerScope }): Promise<DocumentSessionSnapshot> {
    const session = this.require(input.sessionId, input.scope)
    return this.enqueue(session, async () => {
      const status = session.snapshot.status
      if (status !== 'crashed' && status !== 'conflict') throw new DocumentEngineError('invalid_operation', `nothing to reload from while ${status}`)
      const provider = this.providers.get(session.providerId)
      if (provider === undefined) throw new DocumentEngineError('engine_unavailable', `document engine ${session.providerId} is not available`)
      if (status === 'crashed') this.dispatch(session, { type: 'recovering' })
      await this.closeHandle(session)
      await rm(session.workingDir, { recursive: true, force: true })
      const { workingPath, diskRevision } = await createWorkingCopy(session.absolutePath, session.workingDir)
      session.handle = await this.withTimeout((signal) =>
        provider.open({ workingPath, format: session.snapshot.format, onCrash: () => { this.markCrashed(session) } }, signal)
      )
      this.dispatch(session, { type: 'reloaded', diskRevision, restoredRevision: session.snapshot.savedRevision })
      return session.snapshot
    })
  }

  /**
   * 一个视图不用了。最后一个视图离开时:干净 → 关闭会话;脏 → **保留会话**并如实告诉调用方,
   * 由它决定保存还是 `force` 丢弃。
   *
   * ★ 脏会话不自动关:关了就是静默丢掉用户没保存的输入(计划 §5)。
   */
  release(input: { sessionId: string; scope: DocumentCallerScope; viewId: string; force?: boolean }): Promise<{ closed: boolean; dirty: boolean }> {
    const session = this.require(input.sessionId, input.scope)
    session.views.delete(input.viewId)
    return this.enqueue(session, async () => {
      const dirty = isSessionDirty(session.snapshot)
      if (session.views.size > 0) return { closed: false, dirty }
      if (dirty && input.force !== true) return { closed: false, dirty }
      await this.shutdown(session)
      return { closed: true, dirty: false }
    })
  }

  /** 还有未保存改动的会话。退出 / 切账户 / 禁用插件之前问它 */
  dirtySessions(): DocumentSessionSnapshot[] {
    return [...this.sessions.values()].filter((s) => s.snapshot.status !== 'closed' && isSessionDirty(s.snapshot)).map((s) => s.snapshot)
  }

  /**
   * 收掉某个引擎的全部会话(插件禁用 / 卸载),或者不给 providerId 时收掉全部(退出 / 切账户)。
   * 调用方应先用 `dirtySessions` 处理未保存改动;这里不再询问。
   */
  async closeAll(providerId?: string): Promise<void> {
    const targets = [...this.sessions.values()].filter((s) => providerId === undefined || s.providerId === providerId)
    await Promise.all(targets.map((session) => this.enqueue(session, () => this.shutdown(session)).catch(() => undefined)))
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private require(sessionId: string, scope: DocumentCallerScope): Session {
    const session = this.sessions.get(sessionId)
    /*
      ★ 作用域不符和「不存在」报同一个错:区分开的话,一个工作区的调用方可以
      通过错误码探测别的工作区打开了哪些文档。
    */
    if (session === undefined || session.snapshot.status === 'closed' || session.accountScope !== scope.accountScope || !session.workspaceIds.has(scope.workspaceId)) {
      throw new DocumentEngineError('session_closed', 'no such document session')
    }
    return session
  }

  /**
   * 串行队列。★ 前一项失败不能卡住后一项:用 `then(run, run)` 接续,
   * 而返回给调用方的仍是这一项自己的结果 / 错误。
   */
  private enqueue<T>(session: Session, task: () => Promise<T>): Promise<T> {
    const run = session.queue.then(task, task)
    session.queue = run.catch(() => undefined)
    return run
  }

  private async withTimeout<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new DocumentEngineError('timeout', `document engine did not answer within ${this.timeoutMs}ms`))
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([task(controller.signal), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private dispatch(session: Session, event: DocumentSessionEvent): void {
    const next = reduceSession(session.snapshot, event)
    if (next === session.snapshot) return
    session.snapshot = next
    try { this.options.onChange?.(next) } catch { /* 订阅方的问题不影响会话账目 */ }
  }

  private markCrashed(session: Session): void {
    if (session.snapshot.status === 'closed') return
    this.dispatch(session, { type: 'crashed' })
    void this.closeHandle(session)
  }

  private async closeHandle(session: Session): Promise<void> {
    const handle = session.handle
    session.handle = null
    if (handle !== null) await handle.close().catch(() => undefined)
  }

  private async shutdown(session: Session): Promise<void> {
    await this.closeHandle(session)
    this.dispatch(session, { type: 'closed' })
    this.sessions.delete(session.snapshot.sessionId)
    if (this.byKey.get(session.key) === session.snapshot.sessionId) this.byKey.delete(session.key)
    await rm(session.workingDir, { recursive: true, force: true })
  }

  private record(operationId: string, record: OperationRecord): void {
    this.operations.set(operationId, record)
    if (this.operations.size > MAX_OPERATION_RECORDS) {
      const oldest = this.operations.keys().next().value
      if (oldest !== undefined) this.operations.delete(oldest)
    }
  }
}
