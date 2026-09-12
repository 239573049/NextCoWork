import { spawn } from 'node:child_process'
import { constants, promises as fs, type Stats } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { createConnection } from 'node:net'
import type { KernelHost } from '../kernel/host'
import { killTree } from '../kernel/node-spawn'
import type { EnvironmentFs, EnvironmentStat, WorkspaceEnvironment } from './contract'
import { EnvironmentError, missingPath } from './errors'
import { createWorkspacePaths } from './paths'

const attributes = (stat: Stats): EnvironmentStat => ({ size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode,
  isDir: stat.isDirectory(), isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() })

export function localEnvironment(host: KernelHost, rootPath: string): WorkspaceEnvironment {
  const terminalShell = host.platform.os === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh'
  const filesystem: EnvironmentFs = {
    ...host.fs,
    stat: async (path) => attributes(await fs.stat(path)),
    lstat: async (path) => attributes(await fs.lstat(path)),
    readBytes: async (path, limit = 32 * 1024 * 1024) => {
      const handle = await fs.open(path, 'r')
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > limit) throw new EnvironmentError('unsupported')
        const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (bytesRead > limit) throw new EnvironmentError('unsupported')
        return bytes.subarray(0, bytesRead)
      } finally { await handle.close() }
    },
    writeBytes: async (path, bytes, options = {}) => {
      const handle = await fs.open(path, options.exclusive ? 'wx' : 'w', options.mode ?? 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    },
    mkdir: async (path) => { await fs.mkdir(path, { mode: 0o700 }) },
    copyFile: async (source, destination, maxBytes) => {
      const stat = await fs.stat(source)
      if (!stat.isFile() || stat.size > maxBytes) throw new EnvironmentError('unsupported')
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL)
      return stat.size
    },
    rename: async (source, destination, replace = false) => {
      if (!replace) {
        try { await fs.lstat(destination); throw new EnvironmentError('conflict') } catch (error) { if (!missingPath(error)) throw error }
      }
      await fs.rename(source, destination)
    },
    unlink: (path) => fs.unlink(path),
    rmdir: (path) => fs.rmdir(path)
  }
  return {
    key: 'local', rootPath, generation: 0, remote: false, description: 'Local', fs: filesystem, terminalShell,
    path: createWorkspacePaths(filesystem, host.platform.os), platform: host.platform,
    facts: { ...host.platform, home: homedir(), hostname: hostname(), username: userInfo().username },
    assertReady: () => {}, spawn: host.spawn,
    openTcp: async (hostname, port) => createConnection({ host: hostname, port }),
    openProcess: async (command, args, options) => {
      const env = { ...process.env, ...options.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      const detached = options.detached === true
      const child = spawn(command, [...args], { cwd: options.cwd, env, stdio: 'pipe', windowsHide: true, shell: false, detached })
      child.stdin.on('error', () => {})
      return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
        exited: new Promise((resolve) => {
          child.once('close', (code, signal) => resolve({ code, signal }))
          child.once('error', () => resolve({ code: null }))
        }),
        /*
          ★ `detached` 时杀整棵树。`sh -c "npm run x"` 只杀 sh 的话，node 会活下来
          继续占着端口 —— 而调用方看到的是「已经 kill 过了」。理由与实现同
          `kernel/node-spawn.ts` 的 `killTree`，那里是同一个问题的另一条路径。
        */
        kill: () => {
          if (detached && child.pid !== undefined) killTree(child.pid, 'SIGTERM')
          else child.kill()
        } }
    },
    openTerminal: async (options) => {
      const pty = await import('node-pty')
      return pty.spawn(terminalShell, [], { ...options, name: 'xterm-256color', env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string> })
    }
  }
}