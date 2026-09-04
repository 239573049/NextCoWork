/**
 * `SpawnFn` 的纯 Node 实现 —— `bash` 工具脚下的那块地板。
 *
 * 文件不长,但里面三件事都是「不这么写就会在生产里咬人」的那种:
 * 进程组、抽干管道、env 清洗。其余部分是薄的。
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { abortError } from './abort'
import type { SpawnFn, SpawnResult } from './host'

/** 单次调用 stdout / stderr 各自的字符上限。超出后仍然读,只是不再往缓冲里塞。 */
const MAX_STREAM_CHARS = 512 * 1024
/** 先 SIGTERM,给这么久收尾,再 SIGKILL。 */
const KILL_GRACE_MS = 2000
/** 对齐 `timeout(1)`:超时退出码 124。模型见过这个约定,不用我们解释。 */
const TIMEOUT_CODE = 124
/** shell 本身没起来(不存在 / cwd 不存在)。对齐 shell 的 "command not found"。 */
const SPAWN_FAILED_CODE = 127

const isWindows = process.platform === 'win32'

/**
 * ★ 从 `process.env` 拷一份并**摘掉两个会毒害子进程的变量**。
 *
 * - `ELECTRON_RUN_AS_NODE`:父进程是 Electron 时它可能是 1。继承下去,子进程里的
 *   `node` / `npx` 其实是 Electron 二进制在冒充 node,行为诡异且极难归因。
 * - `NODE_OPTIONS`:开发时常带 `--inspect`,子进程继承会抢同一个调试端口然后启动失败。
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

/**
 * ★ 杀**整个进程组**,不是杀那一个 shell。
 *
 * `sh -c "npm run dev"` 被中断时只杀 sh,结果是 `node` 还活着、端口还占着 ——
 * 用户看到的是「我点了停止,但项目跑不起来了」,而且找不到是谁占的端口。
 * POSIX 下 `detached: true` 让子进程成为新进程组的组长(pgid === pid),
 * 于是 `kill(-pid)` 覆盖它派生的一整棵树。
 *
 * Windows 没有进程组的等价物,只能靠 `taskkill /T`。⚠️ v1 的已知缺口:
 * 这条分支没有自动化测试覆盖。
 */
function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    // 已经死了 / 组不存在(ESRCH)。杀一个死人不是错误。
  }
}

/** 信号名 → 编号,给 shell 那套 `128 + n` 的退出码约定用。认不出就当 0。 */
function signalNumber(sig: NodeJS.Signals): number {
  const table = constants.signals as unknown as Record<string, number | undefined>
  return table[sig] ?? 0
}

export function nodeSpawn(): SpawnFn {
  return (cmd, opts) =>
    new Promise<SpawnResult>((resolve, reject) => {
      if (opts.signal.aborted) {
        reject(abortError())
        return
      }

      const [file, args] = isWindows
        ? ['cmd.exe', ['/d', '/s', '/c', cmd]]
        : [process.env.SHELL ?? '/bin/sh', ['-c', cmd]]

      const child = spawn(file, args, {
        cwd: opts.cwd,
        env: childEnv(),
        // POSIX:自成进程组,让 killTree 能一次带走整棵树
        detached: !isWindows,
        /*
          ★ stdin 关掉。留着的话,一个等输入的命令(不带 -m 的 git commit、npm login)
          会永远挂在那里 —— 表现成「工具卡住了」,而没有任何人能给它敲字。
        */
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let killedBy: 'timeout' | 'abort' | null = null
      let graceTimer: NodeJS.Timeout | undefined
      let timeoutTimer: NodeJS.Timeout | undefined

      /*
        ★ 超出预算后**仍然消费数据**,只是不再 append。
        直觉上应该 pause() 或者干脆不读 —— 但那样管道会写满,子进程阻塞在 write 上
        永不退出。症状是「命令挂住了」,而 stdout 里已经有正确的前 512KB,
        看起来完全不像一个背压问题。
      */
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_STREAM_CHARS) stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STREAM_CHARS) stderr += chunk.toString('utf8')
      })

      const { pid } = child

      function terminate(why: 'timeout' | 'abort'): void {
        killedBy = why
        if (pid === undefined) return
        killTree(pid, 'SIGTERM')
        graceTimer = setTimeout(() => killTree(pid, 'SIGKILL'), KILL_GRACE_MS)
        // 宽限计时器不该拖住 Node 退出 —— 进程通常在它到点之前就走了
        graceTimer.unref()
      }

      const onAbort = (): void => {
        terminate('abort')
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })

      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          terminate('timeout')
        }, opts.timeoutMs)
      }

      function cleanup(): void {
        opts.signal.removeEventListener('abort', onAbort)
        if (graceTimer !== undefined) clearTimeout(graceTimer)
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      }

      child.on('error', (err: Error) => {
        cleanup()
        // 命令根本没起来。这是工具错误,不是中断 —— 让模型看见原因,它能自己改。
        resolve({ code: SPAWN_FAILED_CODE, stdout, stderr: `${stderr}${err.message}` })
      })

      child.on('close', (code, signalName) => {
        cleanup()

        /*
          ★ 中断**抛出**,不返回一个 code = -1 的结果。

          `defineTool` 的契约是中断原样抛出、不伪装成工具失败(见 define.ts 文件头)。
          这里返回普通结果的话,每个调用方都得自己记得再查一次 signal ——
          而漏查的那一个,会把「用户点了停止」表现成「命令失败了,换个方式再试一次」。
        */
        if (killedBy === 'abort') {
          reject(abortError())
          return
        }

        if (killedBy === 'timeout') {
          resolve({
            code: TIMEOUT_CODE,
            stdout,
            stderr: `${stderr}\n[命令超时:超过 ${String(opts.timeoutMs)}ms 未结束,已终止整个进程组]`
          })
          return
        }

        if (code !== null) {
          resolve({ code, stdout, stderr })
          return
        }

        // 被外部信号杀掉。用 shell 的 128+signum 约定,而不是编一个 0 出来。
        resolve({
          code: 128 + (signalName === null ? 0 : signalNumber(signalName)),
          stdout,
          stderr: `${stderr}\n[命令被信号 ${signalName ?? '未知'} 终止]`
        })
      })
    })
}
