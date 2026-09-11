import { describe, expect, it } from 'vitest'
import type { SshConnectionProfile } from '../../../shared/domain/environment'
import { POSIX_PROBE, powershellQuote, remoteCommand, remoteExecutable, remoteProcessRequest, shellQuote, sshTargetArgs } from '../ssh/command'
import { sshProcessEnvironment } from '../ssh/transport'

const profile: SshConnectionProfile = { id: 'test', kind: 'ssh', name: 'test', enabled: true, platform: 'auto', revision: 1,
  createdAt: 0, updatedAt: 0, target: { kind: 'config', host: 'my-alias' } }

describe('native SSH command construction', () => {
  it('inherits only client infrastructure variables, not application secrets or Node injection flags', () => {
    const environment = sshProcessEnvironment({ SSH_ASKPASS: '/app/helper', NCW_SSH_AUTH_SECRET: '/tmp/ncw/token' },
      { PATH: '/usr/bin', HOME: '/home/user', SSH_AUTH_SOCK: '/agent', API_KEY: 'must-not-forward', NODE_OPTIONS: '--require=bad', ELECTRON_RUN_AS_NODE: '1' })
    expect(environment).toEqual({ PATH: '/usr/bin', HOME: '/home/user', SSH_AUTH_SOCK: '/agent', SSH_ASKPASS: '/app/helper', NCW_SSH_AUTH_SECRET: '/tmp/ncw/token' })
  })

  /** overrides 也要过 deny：调用方不该有能力把 NODE_OPTIONS 塞进 ssh 子进程。 */
  it('refuses Node injection flags even when a caller passes them as overrides', () => {
    const environment = sshProcessEnvironment({ NODE_OPTIONS: '--require=bad', ELECTRON_RUN_AS_NODE: '1' }, { PATH: '/usr/bin' })
    expect(environment).toEqual({ PATH: '/usr/bin' })
  })

  /**
   * ★ 会打断真实认证路径的那些变量。每一条都对应一种连不上:
   * GSSAPI 找不到票据、Windows 登错账号、FIDO/智能卡 middleware 加载不到、
   * ProxyCommand 走不了企业代理。
   */
  it('carries the variables that real authentication paths depend on', () => {
    const environment = sshProcessEnvironment({}, {
      KRB5CCNAME: 'KEYRING:persistent:1000', KRB5_CONFIG: '/etc/krb5.conf',
      SSH_SK_PROVIDER: '/usr/lib/libsk.so', SSH_PKCS11_HELPER: '/usr/bin/helper',
      XDG_RUNTIME_DIR: '/run/user/1000', HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'internal',
      AWS_PROFILE: 'prod', CLOUDSDK_CORE_PROJECT: 'my-project', TELEPORT_PROXY: 'teleport:443',
      LC_PAPER: 'de_DE.UTF-8', TZ: 'Asia/Shanghai'
    })
    expect(Object.keys(environment).sort()).toEqual([
      'AWS_PROFILE', 'CLOUDSDK_CORE_PROJECT', 'HTTPS_PROXY', 'KRB5CCNAME', 'KRB5_CONFIG', 'LC_PAPER',
      'NO_PROXY', 'SSH_PKCS11_HELPER', 'SSH_SK_PROVIDER', 'TELEPORT_PROXY', 'TZ', 'XDG_RUNTIME_DIR'
    ])
  })

  /** 原始凭据不透传：ProxyCommand 靠 AWS_PROFILE 自己去读凭据文件就够了。 */
  it('does not forward raw cloud credentials', () => {
    const environment = sshProcessEnvironment({}, {
      AWS_PROFILE: 'prod', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token', AWS_ACCESS_KEY_ID: 'id'
    })
    expect(environment).toEqual({ AWS_PROFILE: 'prod' })
  })

  /**
   * ★ Windows 的 process.env 查找大小写不敏感,所以白名单必须按小写比对、保留原始拼写。
   * 逐个列出拼写变体的写法会在子进程环境块里造出重复键,而且永远列不全。
   */
  it('matches Windows variables case-insensitively and keeps the system spelling', () => {
    const environment = sshProcessEnvironment({}, { SYSTEMROOT: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', username: 'token' })
    expect(environment).toEqual({ SYSTEMROOT: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', username: 'token' })
  })

  it('passes the original alias and config file to OpenSSH', () => {
    expect(sshTargetArgs(profile)).toEqual(['my-alias'])
    expect(sshTargetArgs({ ...profile, target: { kind: 'config', host: 'alias', configFile: '/path with spaces/config' } }))
      .toEqual(['-F', '/path with spaces/config', 'alias'])
  })
  it('rejects option injection in destinations', () => {
    expect(() => sshTargetArgs({ ...profile, target: { kind: 'config', host: '-oProxyCommand=bad' } })).toThrow('invalid-profile')
  })
  it('quotes POSIX cwd and command independently', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
    expect(remoteCommand('linux', '/bin/bash', "/work/a'b", 'printf hi')).toBe("cd -- '/work/a'\\''b' && exec '/bin/bash' -c 'printf hi'")
    expect(POSIX_PROBE).toContain('${SHELL:-/bin/sh}')
  })
  it('uses an encoded PowerShell script for Windows paths and commands', () => {
    expect(powershellQuote("a'b")).toBe("'a''b'")
    const command = remoteCommand('win32', 'powershell.exe', 'C:\\work space', 'Get-Location')
    const decoded = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')
    expect(decoded).toContain("Set-Location -LiteralPath 'C:\\work space'")
    expect(decoded).toContain("[ScriptBlock]::Create('Get-Location')")
    expect(() => remoteExecutable('linux', '/bin/sh', '/work', 'node', [], { 'BAD;NAME': 'x' })).toThrow('invalid-profile')
  })
  it('keeps process secrets out of the local SSH argument string', () => {
    for (const os of ['linux', 'win32']) {
      const request = remoteProcessRequest(os, '/bin/sh', '/work', 'node', ['server.js'], { API_KEY: 'secret-value\n' })
      expect(request.command).not.toContain('secret-value')
      expect(request.command).not.toContain(Buffer.from('secret-value\n').toString('base64'))
      expect(request.input).toBeTruthy()
    }
  })
})