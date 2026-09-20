/**
 * Agent 开着的 shell —— 前台那条能被单独掐掉、后台那些能被回读。
 *
 * 需求（两件事，一个注册表）：
 * 1. **工具卡片上的停止按钮。** 以前想掐掉一条跑飞的 `npm test`，唯一的办法是
 *    `agent:abort` ——那会把整轮回复一起停掉。前台命令在这里寄存一个停止句柄，
 *    `shell:stopToolCall` 按 `runId + callId` 找到它，只掐那一条。
 * 2. **后台命令（`run_in_background`）。** `npm run dev` 这种不会自己结束的进程，
 *    等它 = 撞满超时 = 白等两分钟，而模型看到的是「超时」于是再试一次。
 *    后台进程住在这里，输出攒在环形缓冲里，`BashOutput` 回读、`KillShell` 收工。
 *
 * ★ **为什么两件事在同一张表里**：它们回答的是同一个问题——「这一刻 agent 手上
 *   还开着哪些 shell」。拆成两个注册表之后，「全部停掉」（退出、切工作区）就得记得
 *   调两次，而漏掉的那一次留下的是用户看不见、也杀不掉的进程。
 *
 * ★ **进程不由这里创建**：`openProcess` 在 `WorkspaceEnvironment` 上，本地与 SSH
 *   两条路都走那一个端口。这个文件只拿到已经起好的进程 + 一把环境租约
 *   （`release`），因此它既不认识 electron，也不认识 ssh。
 *
 * ★ **后台 shell 不随 run 结束而结束**，这正是它的用途。它们的终点只有三个：
 *   自己退出、`KillShell`、应用退出（`shutdown()`）。所以数量必须有上限，
 *   见 `BACKGROUND_SHELL_LIMITS.MAX_RUNNING` 上那段。
 */
import type { Readable } from 'node:stream'
import {
  BACKGROUND_SHELL_LIMITS as LIMITS,
  type BackgroundShellInfo,
  type BackgroundShellRead,
  type ShellBridge
} from '../shared/domain/shell'
import type { EnvironmentLease, EnvironmentProcess, WorkspaceEnvironment } from './environment/contract'
import { shellFor, shellVerbatimArguments } from './environment/shell'

/** 一条已读走的输出缓冲。读取即清空，于是两次读之间不重不漏。 */
interface Stream {
  buffer: string
  dropped: boolean
}

interface BackgroundEntry {
  info: BackgroundShellInfo
  stdout: Stream
  stderr: Stream
  process: EnvironmentProcess
  /** 环境租约。★ 必须活到进程结束——SSH 连接空闲 60s 就会被回收，见 manager.ts。 */
  release: () => void
}

function emptyStream(): Stream {
  return { buffer: '', dropped: false }
}

/**
 * 往缓冲里塞一段，超预算就丢最早的。
 *
 * ★ 丢最早的、而不是不再接收：不接收的话管道会写满，子进程阻塞在 write 上再也
 * 不退出——症状是「后台服务突然不动了」，而日志的前 256KB 完全正常，
 * 看起来一点都不像背压（同 `kernel/node-spawn.ts` 里那段）。
 */
function append(stream: Stream, chunk: string): void {
  stream.buffer += chunk
  if (stream.buffer.length <= LIMITS.MAX_BUFFER_CHARS) return
  stream.buffer = stream.buffer.slice(stream.buffer.length - LIMITS.MAX_BUFFER_CHARS)
  stream.dropped = true
}

/** 读走并清空。`filter` 是按**行**过滤的正则，调用方已经筛过 ReDoS。 */
function take(stream: Stream, filter: RegExp | undefined): string {
  const text = stream.buffer
  stream.buffer = ''
  if (filter === undefined || text === '') return text
  return text.split('\n').filter((line) => filter.test(line)).join('\n')
}

export class AgentShells {
  /** `runId\u0000callId` → 停止那一条前台命令。 */
  private readonly foreground = new Map<string, { command: string; stop: () => void }>()
  private readonly background = new Map<string, BackgroundEntry>()
  /**
   * 发号器。★ **只增不复用**，哪怕那条 shell 已经被淘汰出表：
   * 复用 id 的话，模型拿着一个旧 id 调 `BashOutput`，读到的是另一条命令的输出，
   * 而两边都不会报错。
   */
  private sequence = 0

  // ─────────────────────────── 前台 ───────────────────────────

  hold(call: { runId: string; callId: string; command: string }, stop: () => void): () => void {
    const key = `${call.runId}\u0000${call.callId}`
    this.foreground.set(key, { command: call.command, stop })
    return () => {
      this.foreground.delete(key)
    }
  }

  /** 返回「真的停了一条」。false = 它已经不在跑了，见 `shell:stopToolCall` 的契约。 */
  stopCall(runId: string, callId: string): boolean {
    const entry = this.foreground.get(`${runId}\u0000${callId}`)
    if (entry === undefined) return false
    entry.stop()
    return true
  }

  // ─────────────────────────── 后台 ───────────────────────────

  /**
   * 收编一个已经起好的进程。
   *
   * ★ 订阅 stdout/stderr 要在**同一个同步块**里做完：`openProcess` 返回之后
   * 进程已经在跑了，晚一个 tick 订阅就会丢掉它启动时打的头几行——而那几行
   * 恰恰是「端口被占用」之类最该被看到的话。
   */
  adopt(req: {
    command: string
    description?: string
    cwd: string
    runId: string
    callId: string
    workspaceId: string
    startedAt: number
    process: EnvironmentProcess
    release: () => void
  }): BackgroundShellInfo {
    const id = `bash_${String(++this.sequence)}`
    const entry: BackgroundEntry = {
      info: {
        id,
        command: req.command,
        ...(req.description === undefined ? {} : { description: req.description }),
        cwd: req.cwd,
        status: 'running',
        startedAt: req.startedAt,
        runId: req.runId,
        callId: req.callId,
        workspaceId: req.workspaceId
      },
      stdout: emptyStream(),
      stderr: emptyStream(),
      process: req.process,
      release: req.release
    }
    this.background.set(id, entry)

    const pipe = (source: Readable, stream: Stream): void => {
      source.setEncoding('utf8')
      source.on('data', (chunk: string) => append(stream, chunk))
      // 进程被杀时管道会抛 EPIPE/ECONNRESET。它不是一个要上报的错误，
      // 而没有这个监听器的话 Node 会把它升级成 uncaughtException 打死主进程。
      source.on('error', () => {})
    }
    pipe(req.process.stdout, entry.stdout)
    pipe(req.process.stderr, entry.stderr)

    void req.process.exited.then(({ code }) => {
      entry.release()
      // 已经是 killed 的就不要改回 exited——「是我们杀的」这件事退出码里没有。
      if (entry.info.status === 'running') {
        entry.info.status = 'exited'
        if (code !== null) entry.info.exitCode = code
      }
      entry.info.endedAt = Date.now()
      this.evict()
    })
    this.evict()
    return { ...entry.info }
  }

  runningCount(): number {
    let n = 0
    for (const entry of this.background.values()) if (entry.info.status === 'running') n++
    return n
  }

  read(id: string, filter?: RegExp): BackgroundShellRead {
    const entry = this.background.get(id)
    if (entry === undefined) throw new Error(unknownShell(id, this.list()))
    const dropped = entry.stdout.dropped || entry.stderr.dropped
    entry.stdout.dropped = false
    entry.stderr.dropped = false
    return {
      info: { ...entry.info },
      stdout: take(entry.stdout, filter),
      stderr: take(entry.stderr, filter),
      dropped
    }
  }

  kill(id: string): BackgroundShellInfo {
    const entry = this.background.get(id)
    if (entry === undefined) throw new Error(unknownShell(id, this.list()))
    if (entry.info.status === 'running') {
      // 先标状态再杀：`exited` 回调可能在同一个 tick 里就到，那时它必须看得出
      // 这是一次主动终止，而不是进程自己退的（两者对模型意味着不同的事）。
      entry.info.status = 'killed'
      entry.info.endedAt = Date.now()
      entry.process.kill()
    }
    return { ...entry.info }
  }

  list(): BackgroundShellInfo[] {
    return [...this.background.values()].map((entry) => ({ ...entry.info }))
  }

  /**
   * 应用退出 / 测试收尾：杀光所有后台进程。
   *
   * ★ 不杀的话它们会**活过应用本身**：`detached` 的进程组不随父进程消失，
   * 用户重启应用后端口还占着，而界面上再也找不到是谁占的。
   */
  shutdown(): void {
    for (const entry of this.background.values()) {
      if (entry.info.status === 'running') {
        entry.info.status = 'killed'
        entry.info.endedAt = Date.now()
        entry.process.kill()
      }
      entry.release()
    }
    this.background.clear()
    this.foreground.clear()
  }

  /** 只淘汰**已结束**的，从最早结束的那条开始。还在跑的一律不动。 */
  private evict(): void {
    if (this.background.size <= LIMITS.MAX_TRACKED) return
    const finished = [...this.background.values()]
      .filter((entry) => entry.info.status !== 'running')
      .sort((left, right) => (left.info.endedAt ?? 0) - (right.info.endedAt ?? 0))
    for (const entry of finished) {
      if (this.background.size <= LIMITS.MAX_TRACKED) return
      this.background.delete(entry.info.id)
    }
  }
}

/**
 * 找不到 id 时给模型的那句话。
 *
 * ★ 必须把**现在有哪些**列出来。只说「没有这个 shell」的话，模型会原样重试一次
 * （它认为是自己手抖），而真正的原因通常是那条 shell 已经跑完并被淘汰了。
 */
function unknownShell(id: string, current: readonly BackgroundShellInfo[]): string {
  const listed = current.length === 0
    ? 'There are no background shells right now.'
    : `Currently tracked: ${current.map((s) => `${s.id} (${s.status})`).join(', ')}.`
  return `There is no background shell with id "${id}". ${listed} Do not retry with the same id.`
}

/** 进程内单例 —— 同 `runs` / `interactions`，「谁开着 shell」只能有一份答案。 */
export const agentShells = new AgentShells()

/**
 * 装配一个 run 的 `ToolContext.shells`。
 *
 * ★ `retain` 由调用方给(`runtime.ts` 用 `getEnvironments().retain(environment)`)：
 * 这个文件不认识环境管理器，否则 `runtime → agent-shells → runtime` 就成环了。
 *
 * ★ 租约在**起进程时**才取，且一直持到进程退出。run 结束时释放它自己那把，
 * 后台进程握着的这把让 SSH 连接继续活着——否则后台命令会在 run 结束 60 秒后
 * 连同连接一起消失，而 `BashOutput` 只会说「读不到」。
 */
export function shellBridgeFor(deps: {
  workspaceId: string
  environment: WorkspaceEnvironment
  retain: () => EnvironmentLease
  now: () => number
  shells?: AgentShells
}): ShellBridge {
  const registry = deps.shells ?? agentShells
  return {
    hold: (call, stop) => registry.hold(call, stop),
    start: async (req) => {
      if (registry.runningCount() >= LIMITS.MAX_RUNNING) {
        throw new Error(
          `Too many background shells are already running (${String(LIMITS.MAX_RUNNING)}). `
          + 'Use KillShell to stop one you no longer need, or run this command in the foreground.'
        )
      }
      const shell = shellFor(deps.environment)
      const lease = deps.retain()
      try {
        const process = await deps.environment.openProcess(shell.command, shell.args(req.command), {
          cwd: req.cwd,
          // ★ 后台命令几乎总会再派生子进程(`npm run dev` → node)。只杀那一个 shell
          //   的话，端口还占着，而 KillShell 已经报告「停了」。
          detached: true,
          windowsVerbatimArguments: shellVerbatimArguments(deps.environment, shell.command)
        })
        return registry.adopt({
          command: req.command,
          ...(req.description === undefined ? {} : { description: req.description }),
          cwd: req.cwd,
          runId: req.runId,
          callId: req.callId,
          workspaceId: deps.workspaceId,
          startedAt: deps.now(),
          process,
          release: lease.release
        })
      } catch (error) {
        // 起不来就当场还租约。不还的话一次拼错的命令会让 SSH 连接永远不空闲。
        lease.release()
        throw error
      }
    },
    read: (id, filter) => registry.read(id, filter === undefined ? undefined : new RegExp(filter)),
    kill: (id) => registry.kill(id),
    list: () => registry.list()
  }
}
