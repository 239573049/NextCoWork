/**
 * Windows 那条「一次认证,后面所有命令复用」的多路复用。
 *
 * 用本机 python 跑和远端同一份脚本,走真实的 stdin/stdout 帧,而不是 mock:
 * 帧边界、banner 前的噪声、并发通道这些错,mock 原理上对得上、真跑对不上。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { SessionMux, muxPythonLaunchCode } from '../ssh/session-mux'

function startMux(): { mux: SessionMux; kill: () => void } {
  const child = spawn('python', ['-S', '-u', '-c', muxPythonLaunchCode()], { windowsHide: true, stdio: 'pipe' })
  const mux = new SessionMux(child.stdin, child.stdout, () => {})
  child.stderr.on('data', () => {})
  return { mux, kill: () => child.kill() }
}

it('runs several commands over one session without starting another process', async () => {
  const { mux, kill } = startMux()
  try {
    await mux.ready
    const first = await mux.exec('echo one', AbortSignal.timeout(10_000), 10_000)
    const second = await mux.exec('echo two', AbortSignal.timeout(10_000), 10_000)
    expect(first).toMatchObject({ code: 0, stdout: expect.stringContaining('one') })
    expect(second).toMatchObject({ code: 0, stdout: expect.stringContaining('two') })
    const failed = await mux.exec('exit 7', AbortSignal.timeout(10_000), 10_000)
    expect(failed.code).toBe(7)
  } finally { mux.close(); kill() }
})

it('keeps a long-lived process open and writes to its stdin', async () => {
  const { mux, kill } = startMux()
  try {
    await mux.ready
    const process = mux.openProcess('python -c "import sys; print(sys.stdin.readline().strip())"')
    process.stdin.write('hello-mux\n')
    process.stdin.end()
    const chunks: Buffer[] = []
    process.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    const exit = await process.exited
    expect(exit.code).toBe(0)
    expect(Buffer.concat(chunks).toString('utf8')).toContain('hello-mux')
  } finally { mux.close(); kill() }
})

it('forwards a tcp connection through the same session', async () => {
  const server = createServer((socket) => { socket.end('pong') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const { mux, kill } = startMux()
  try {
    await mux.ready
    const socket = await mux.openTcp('127.0.0.1', address.port)
    const received = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.on('error', reject)
    })
    expect(received).toBe('pong')
  } finally { mux.close(); kill(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

it('fails ready instead of treating pre-banner noise as a live session', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let died = false
  const mux = new SessionMux(input, output, () => { died = true })
  output.end(Buffer.alloc(5000, 0x61))
  await expect(mux.ready).rejects.toThrow(/banner/)
  expect(died, 'banner 之前断掉是没建起来,不是一次掉线').toBe(false)
})
