/**
 * 原生文档引擎 helper 的**进程与协议**适配 —— 把一个跑在插件包里的原生进程
 * 包装成 `DocumentEngineProvider`,交给 `manager.ts`。
 *
 * ## 为了什么需求建的
 *
 * 办公插件自带的 LibreOffice 引擎不能进 Electron 主进程(崩溃会带走整个应用、
 * 原生内存问题无从隔离),也不能进 iframe(没有 Node)。所以每份打开的文档由
 * 一个独立 helper 进程承载,主进程经 stdio 分帧协议(`native-frame.ts`)和它说话。
 * 这个文件负责:起进程、握手、请求/回执配对、崩溃检测、收尾。
 *
 * ## 协议 v1(控制帧都是 JSON)
 *
 * ```
 * helper → 主进程(启动后第一帧)  { v:1, event:'hello', data:{ protocol:1, engineVersion } }
 * 主进程 → helper                  { v:1, id, method, params }
 * helper → 主进程                  { v:1, id, ok:true, result } | { v:1, id, ok:false, error:{ code, message } }
 * helper → 主进程(主动事件)      { v:1, event, data }
 * ```
 *
 * 方法:`document.open { path, format }` → `{ capabilities }`;
 * `document.apply { operations }` → `{ warnings, undoable }`;
 * `document.saveAs { path, format }` → `{}`;`shutdown {}` → `{}`。
 *
 * ## 不变式
 *
 * - **每次 spawn 前核对入口摘要**(`resolveEntry` 由调用方传入 `native-installer.ts`
 *   的 `resolveVerifiedEntry`),不信安装时那一次。
 * - **不走 shell、不继承凭据环境。** 只给 helper 一份白名单环境,HOME / TMP 指向
 *   私有工作目录:引擎 profile 与临时文件不落到用户家目录,也拿不到 API key 之类的变量。
 * - **helper 的回执是不可信输入。** capability 只保留宿主认得的操作;错误码只认
 *   协议里定义过的,其余一律 `io`。
 * - 进程意外退出 → 所有在途请求以 `engine_crashed` 失败,并通知会话管理器;
 *   管理器据此把在途修改记为「结果未知」,绝不重放。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DocumentEngineError,
  isDocumentFormat,
  isDocumentOperationKind,
  type DocumentCapabilities,
  type DocumentErrorCode,
  type DocumentFormat,
  type DocumentOperation,
  type DocumentQuery
} from '../../shared/document-engine/protocol'
import { NATIVE_PROTOCOL_VERSION } from '../../shared/plugin/native-component'
import { killTree } from '../kernel/node-spawn'
import type { DocumentEngineHandle, DocumentEngineProvider } from './manager'
import { FrameDecoder, encodeJsonFrame } from './native-frame'

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const SHUTDOWN_GRACE_MS = 2_000
/** stderr 只留尾巴做诊断。★ 不设上限的话一个疯狂打日志的 helper 能吃光主进程内存 */
const STDERR_TAIL_BYTES = 16 * 1024

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<DocumentErrorCode>([
  'unsupported_format', 'unsupported_operation', 'invalid_operation', 'stale_revision', 'stale_generation',
  'disk_conflict', 'timeout', 'macro_denied', 'io', 'engine_crashed'
])

export type SpawnHelper = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams

const defaultSpawn: SpawnHelper = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    // POSIX:自成进程组,收尾时 killTree 能带走引擎派生的子进程
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  })

/**
 * helper 的环境变量白名单。
 *
 * ★ 显式列举而不是「复制 process.env 再删几个」:删除式清单漏一个就是把一枚
 * token 交给第三方原生代码,而新增的敏感变量永远不会有人记得回来加进删除表。
 */
export function helperEnv(workDir: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: join(workDir, 'home'),
    USERPROFILE: join(workDir, 'home'),
    TMPDIR: join(workDir, 'tmp'),
    TMP: join(workDir, 'tmp'),
    TEMP: join(workDir, 'tmp')
  }
  // 动态库装载与本地化需要的少数几项,原样透传
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'FONTCONFIG_PATH']) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class NativeHelperConnection {
  private readonly pending = new Map<number, Pending>()
  private readonly exitListeners = new Set<(reason: string) => void>()
  private nextId = 1
  private stderrTail = ''
  private exited = false
  private closing = false
  engineVersion = ''

  private constructor(private readonly child: ChildProcessWithoutNullStreams, readonly workDir: string) {}

  /**
   * 起 helper 并等 `hello` 握手。握手超时 / 协议版本不符 / 先退出 → 抛 `engine_unavailable`。
   */
  static async start(options: {
    command: string
    args?: string[]
    workDir: string
    startupTimeoutMs?: number
    spawnImpl?: SpawnHelper
  }): Promise<NativeHelperConnection> {
    await mkdir(join(options.workDir, 'home'), { recursive: true, mode: 0o700 })
    await mkdir(join(options.workDir, 'tmp'), { recursive: true, mode: 0o700 })
    const child = (options.spawnImpl ?? defaultSpawn)(options.command, options.args ?? [], {
      cwd: options.workDir,
      env: helperEnv(options.workDir)
    })
    const connection = new NativeHelperConnection(child, options.workDir)
    await connection.handshake(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    return connection
  }

  private handshake(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let greeted = false
      const fail = (message: string): void => {
        if (greeted) return
        greeted = true
        clearTimeout(timer)
        this.kill()
        reject(new DocumentEngineError('engine_unavailable', message))
      }
      const timer = setTimeout(() => { fail(`document engine did not start within ${timeoutMs}ms${this.stderrSuffix()}`) }, timeoutMs)
      const decoder = new FrameDecoder()
      this.child.stderr.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
      })
      this.child.on('error', (error) => { fail(`document engine failed to start: ${error.message}`) })
      this.child.on('exit', (code, signal) => {
        this.exited = true
        const reason = `document engine exited (${signal ?? String(code)})${this.stderrSuffix()}`
        fail(reason)
        this.failAll(reason)
        if (!this.closing) for (const listener of this.exitListeners) listener(reason)
      })
      this.child.stdout.on('data', (chunk: Buffer) => {
        let frames
        try {
          frames = decoder.push(chunk)
        } catch (error) {
          // 字节流失步没有恢复办法,只能收掉这个 helper(见 native-frame.ts)
          const reason = `document engine protocol error: ${(error as Error).message}`
          fail(reason)
          this.failAll(reason)
          this.kill()
          return
        }
        for (const frame of frames) {
          if (frame.kind !== 'json') continue // 二进制附件(tile)由后续画布通道消费,这一版不接
          const message = frame.value as Record<string, unknown> | null
          if (message === null || typeof message !== 'object' || message.v !== 1) continue
          if (!greeted && message.event === 'hello') {
            const data = (message.data ?? {}) as Record<string, unknown>
            if (data.protocol !== NATIVE_PROTOCOL_VERSION) {
              fail(`document engine speaks protocol ${String(data.protocol)}, host expects ${NATIVE_PROTOCOL_VERSION}`)
              return
            }
            this.engineVersion = typeof data.engineVersion === 'string' ? data.engineVersion.slice(0, 128) : ''
            greeted = true
            clearTimeout(timer)
            resolve()
            continue
          }
          if (typeof message.id === 'number') this.settle(message)
        }
      })
    })
  }

  onExit(listener: (reason: string) => void): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.exited) return Promise.reject(new DocumentEngineError('engine_crashed', 'document engine is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return
        reject(new DocumentEngineError('timeout', `${method} was cancelled`))
      }
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener('abort', onAbort); resolve(value) },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error) }
      })
      if (signal !== undefined) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.child.stdin.write(encodeJsonFrame({ v: 1, id, method, params }))
    })
  }

  /**
   * 收尾:先礼后兵。发 `shutdown` 等一小会儿,不走就杀整棵进程树,最后删私有目录。
   */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (!this.exited) {
      const exited = new Promise<void>((resolve) => { this.child.once('exit', () => { resolve() }) })
      this.request('shutdown', {}).catch(() => undefined)
      const graceful = await Promise.race([exited.then(() => true), delay(SHUTDOWN_GRACE_MS).then(() => false)])
      if (!graceful) {
        this.kill()
        await Promise.race([exited, delay(SHUTDOWN_GRACE_MS)])
      }
    }
    this.failAll('document engine closed')
    await rm(this.workDir, { recursive: true, force: true })
  }

  private settle(message: Record<string, unknown>): void {
    const pending = this.pending.get(message.id as number)
    if (pending === undefined) return // 已取消 / 迟到的回执
    this.pending.delete(message.id as number)
    if (message.ok === true) { pending.resolve(message.result); return }
    const error = (message.error ?? {}) as Record<string, unknown>
    const code = typeof error.code === 'string' && KNOWN_ERROR_CODES.has(error.code) ? (error.code as DocumentErrorCode) : 'io'
    const text = typeof error.message === 'string' ? error.message.slice(0, 2000) : 'document engine error'
    pending.reject(new DocumentEngineError(code, text))
  }

  private failAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new DocumentEngineError('engine_crashed', reason))
    }
  }

  private kill(): void {
    const pid = this.child.pid
    if (pid === undefined || this.exited) return
    killTree(pid, 'SIGKILL')
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim()
    return tail === '' ? '' : `: ${tail.slice(-500)}`
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * helper 回报的 capability → 宿主认得的形状。
 *
 * ★ 格式必须与打开的文件一致、操作只保留协议里有的:helper 声称支持一个宿主不认识的
 * 操作,UI 和 Agent 就会画出 / 下发一个没有校验器的操作。
 */
export function parseCapabilities(raw: unknown, format: DocumentFormat, engineVersion: string): DocumentCapabilities {
  const record = (raw ?? {}) as Record<string, unknown>
  const caps = (record.capabilities ?? {}) as Record<string, unknown>
  const operations = Array.isArray(caps.operations) ? [...new Set(caps.operations.filter(isDocumentOperationKind))] : []
  const canExport = Array.isArray(caps.canExport) ? [...new Set(caps.canExport.filter(isDocumentFormat))] : []
  const macros = (caps.macros ?? {}) as Record<string, unknown>
  return {
    format,
    engineVersion,
    operations,
    canSave: caps.canSave === true,
    canExport,
    canUndo: caps.canUndo === true,
    macros: { list: macros.list === true, run: macros.run === true }
  }
}

/**
 * 把一个插件携带的原生引擎包装成 `DocumentEngineProvider`。**一份文档一个 helper 进程。**
 *
 * ★ 一文档一进程是刻意的:某份损坏文档把引擎拖崩,只影响它自己的会话,
 * 其它打开着的文档里未保存的输入不会被一起带走。代价是多份文档多份内存。
 */
export class NativeDocumentEngineProvider implements DocumentEngineProvider {
  constructor(
    private readonly options: {
      id: string
      formats: readonly DocumentFormat[]
      /** 每次 spawn 前核对并返回入口绝对路径(`resolveVerifiedEntry`) */
      resolveEntry: () => Promise<string>
      /** 账户私有目录下 helper 的工作根 */
      workRoot: string
      startupTimeoutMs?: number
      spawnImpl?: SpawnHelper
      args?: string[]
    }
  ) {}

  get id(): string { return this.options.id }
  get formats(): readonly DocumentFormat[] { return this.options.formats }

  async open(
    input: { workingPath: string; format: DocumentFormat; onCrash: () => void },
    signal: AbortSignal
  ): Promise<DocumentEngineHandle> {
    const command = await this.options.resolveEntry()
    const connection = await NativeHelperConnection.start({
      command,
      ...(this.options.args === undefined ? {} : { args: this.options.args }),
      workDir: join(this.options.workRoot, randomUUID()),
      ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      ...(this.options.spawnImpl === undefined ? {} : { spawnImpl: this.options.spawnImpl })
    })
    const unsubscribe = connection.onExit(() => { input.onCrash() })
    let capabilities: DocumentCapabilities
    try {
      const opened = await connection.request('document.open', { path: input.workingPath, format: input.format }, signal)
      capabilities = parseCapabilities(opened, input.format, connection.engineVersion)
    } catch (error) {
      unsubscribe()
      await connection.close()
      throw error
    }
    return {
      capabilities,
      apply: async (operations: DocumentOperation[], applySignal: AbortSignal) => {
        const raw = (await connection.request('document.apply', { operations }, applySignal) ?? {}) as Record<string, unknown>
        const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === 'string').slice(0, 50).map((w) => w.slice(0, 500)) : []
        return { warnings, undoable: raw.undoable === true }
      },
      saveTo: async (outputPath: string, saveSignal: AbortSignal) => {
        await connection.request('document.saveAs', { path: outputPath, format: input.format }, saveSignal)
      },
      // 查询请求已由管理器 `validateQuery` 收窄过;结果是 helper 的回执,原样交回调用方
      query: async (request: DocumentQuery, querySignal: AbortSignal) => connection.request('document.query', request, querySignal),
      close: async () => {
        unsubscribe()
        await connection.close()
      }
    }
  }
}
