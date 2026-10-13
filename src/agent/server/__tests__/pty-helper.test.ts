import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensurePtyHelperExecutable } from '../pty-helper'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ncw-pty-helper-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const mode = (path: string): number => statSync(path).mode & 0o777
const helper = (...dir: readonly string[]): string => join(root, ...dir, 'spawn-helper')

/** 造一个假的 node-pty:真包与它只差这些文件,`pty.node` 与 `spawn-helper` 同目录才是重点。 */
function fakeNodePty(dirs: readonly string[], helperMode = 0o644): (specifier: string) => string {
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'pty.node'), 'native')
    writeFileSync(join(root, dir, 'spawn-helper'), 'helper')
    chmodSync(join(root, dir, 'spawn-helper'), helperMode)
  }
  writeFileSync(join(root, 'package.json'), '{"name":"node-pty","version":"1.1.0"}')
  return () => join(root, 'package.json')
}

describe('node-pty helper 的执行位', () => {
  it('gives a prebuilt spawn-helper its exec bit and keeps its contents', () => {
    const resolve = fakeNodePty(['prebuilds/darwin-arm64'])
    expect(ensurePtyHelperExecutable({ platform: 'darwin', arch: 'arm64', resolve })).toBeNull()
    expect(mode(helper('prebuilds', 'darwin-arm64'))).toBe(0o755)
  })

  it('leaves an already executable helper exactly as it is', () => {
    const resolve = fakeNodePty(['prebuilds/darwin-arm64'], 0o700)
    expect(ensurePtyHelperExecutable({ platform: 'darwin', arch: 'arm64', resolve })).toBeNull()
    expect(mode(helper('prebuilds', 'darwin-arm64'))).toBe(0o700)
  })

  it('fixes the helper in the directory node-pty actually loads the native module from', () => {
    // 只有 build/Debug 与 prebuilds 时,node-pty 载入 build/Debug —— 补 prebuilds 等于没补。
    const resolve = fakeNodePty(['prebuilds/darwin-arm64', 'build/Debug'])
    expect(ensurePtyHelperExecutable({ platform: 'darwin', arch: 'arm64', resolve })).toBeNull()
    expect(mode(helper('build', 'Debug'))).toBe(0o755)
    expect(mode(helper('prebuilds', 'darwin-arm64'))).toBe(0o644)
  })

  it('does nothing when node-pty is not installed or when the platform does not use exec bits', () => {
    const absent = (): string => { throw new Error('Cannot find module node-pty') }
    expect(ensurePtyHelperExecutable({ platform: 'darwin', arch: 'arm64', resolve: absent })).toBeNull()
  })

  /*
    Windows 不看执行位:`chmod` 在 Win32 上只翻转只读位,`stat` 回来的 mode 因此恒是
    `644 | 666 & umask`(本机实测 0o666),1/4/8 三个位怎么设都读不回来。这条早就写在
    用例名里了,只是断言本身还在按 POSIX 的规矩数字节 —— 于是 Windows 上必然红。
    真正要断的是「**没有去改**这个文件」:内容与调用前的 mode 都不动。
  */
  it.skipIf(process.platform === 'win32')('leaves a Windows helper alone (no exec bits on that platform)', () => {
    const resolve = fakeNodePty(['prebuilds/win32-x64'])
    const before = statSync(helper('prebuilds', 'win32-x64')).mode
    expect(ensurePtyHelperExecutable({ platform: 'win32', arch: 'x64', resolve })).toBeNull()
    expect(statSync(helper('prebuilds', 'win32-x64')).mode).toBe(before)
    expect(mode(helper('prebuilds', 'win32-x64'))).toBe(0o644)
    expect(readFileSync(helper('prebuilds', 'win32-x64'), 'utf8')).toBe('helper')
  })

  // chflags uchg 是 macOS 上唯一不需要 root 就能让 chmod 失败的办法;Linux 上要 root 才能 chattr +i。
  it.skipIf(process.platform !== 'darwin')('reports why the exec bit could not be set instead of throwing', () => {
    const resolve = fakeNodePty(['prebuilds/darwin-arm64'])
    execFileSync('chflags', ['uchg', helper('prebuilds', 'darwin-arm64')])
    try {
      expect(ensurePtyHelperExecutable({ platform: 'darwin', arch: 'arm64', resolve })).toContain('could not be made executable')
    } finally {
      execFileSync('chflags', ['nouchg', helper('prebuilds', 'darwin-arm64')])
    }
  })
})
