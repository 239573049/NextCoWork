/**
 * KernelHost —— 方案 §2 的端口集。**内核对外部世界的唯一开口。**
 *
 * 「内核零 electron import」不是洁癖,它买到两样具体的东西:
 * 1. `src/main/kernel/**` 的单测在普通 Node 里跑,不用启动 Electron
 *    (`vitest.config.ts` 的 `environment: 'node'` 就是靠这条成立的);
 * 2. `fetch` 是**注入**的,所以「换成 net.fetch 走公司代理」「测试里打桩」
 *    「内置演示上游」三件事共用同一个口子,而不是三处 if。
 *
 * ★ 本文件同时提供 `nodeHost()` —— 一个纯 Node 实现。它不是「测试替身」,
 * 而是**真实默认值**:Electron 侧只覆盖 `secrets` 与 `paths` 两项
 * (safeStorage 和 app.getPath 是仅有的两个真正需要 Electron 的能力)。
 * 这样「内核能不能脱离 Electron 跑」这个问题不靠自律维持,靠默认路径维持。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFs } from './node-fs'
import { nodeSpawn } from './node-spawn'

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

/**
 * 文件工具的能力面。**所有路径必须先过 `resolveInWorkspace`**(方案 §9)——
 * 这里一律收绝对路径,是为了让「围栏在哪」这个问题只有一个答案:在调用方。
 *
 * ★ 刻意**没有** `remove` / `rename`。内置工具用不到,而一个「先留着以后再说」的
 * 空方法会静默变成一次误删 —— 端口宁可缺,不要哑。
 */
export interface KernelFs {
  readFile(absPath: string): Promise<string>
  writeFile(absPath: string, content: string): Promise<void>
  readDir(absPath: string): Promise<Array<{ name: string; isDir: boolean }>>
  stat(absPath: string): Promise<{ size: number; mtimeMs: number; isDir: boolean }>
  realpath(absPath: string): Promise<string>
  /**
   * 只读前 `maxBytes` 个**字节**,不解码。二进制探测必须在解码之前做完 ——
   * 只有 readFile 的话,一个 300MB 的 .pack 会先被 utf8 解成一堆 U+FFFD
   * 再被判定为二进制:判断是对的,代价是主进程刚卡了两秒并分配了 600MB。
   */
  readFileBytes(absPath: string, maxBytes?: number): Promise<Uint8Array>
  /** 建 `absPath` 的**父目录**。没有它,模型写 src/a/b/c.ts 永远 ENOENT。 */
  mkdirp(absPath: string): Promise<void>
  /** 存在性是个问句不是个异常 —— 用 stat 抛错表达它,每个调用点都会变成 try/catch。 */
  exists(absPath: string): Promise<boolean>
}

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * ★ Agent 的 bash 工具**不复用**交互式 PTY(方案 §6):混用会让工具输出和用户
 * 正在敲的字交错,且工具拿不到干净的 exit code。所以这里是 spawn 语义,不是 pty。
 */
export type SpawnFn = (
  cmd: string,
  opts: { cwd: string; signal: AbortSignal; timeoutMs?: number }
) => Promise<SpawnResult>

export interface KernelHost {
  paths: { userData(): string; temp(): string }
  /** ★ 只存引用,永不在内核里出现明文 key(方案 §9) */
  secrets: {
    get(ref: string): Promise<string | null>
    set(ref: string, value: string): Promise<void>
    /** Linux 无 keyring 时为 false —— 调用方必须有明确的降级路径,不是一个未处理的 false */
    available(): boolean
  }
  clock: { now(): number }
  logger: Logger
  fs: KernelFs
  spawn: SpawnFn
  fetch: typeof fetch
}

const consoleLogger: Logger = {
  debug: (m, ...a) => console.debug(m, ...a),
  info: (m, ...a) => console.log(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a)
}

/**
 * 纯 Node 的默认 host。
 *
 * `secrets` 在这里是**进程内内存**,不是持久化 —— Electron 侧会用 safeStorage
 * 覆盖掉它。留一个能用的内存实现(而不是抛错)是为了让内核的单测能走完
 * 「取凭证 → 发请求」这条路,而不必每个测试都自己搭一个 host。
 */
export function nodeHost(overrides: Partial<KernelHost> = {}): KernelHost {
  const mem = new Map<string, string>()
  return {
    paths: {
      userData: () => join(tmpdir(), 'nextcowork-dev'),
      temp: () => tmpdir()
    },
    secrets: {
      get: async (ref) => mem.get(ref) ?? null,
      set: async (ref, v) => {
        mem.set(ref, v)
      },
      available: () => true
    },
    clock: { now: () => Date.now() },
    logger: consoleLogger,
    fs: nodeFs(),
    spawn: nodeSpawn(),
    // 绑定到 globalThis:直接传 `fetch` 引用在某些运行时会丢 this
    fetch: (input, init) => globalThis.fetch(input, init),
    ...overrides
  }
}
