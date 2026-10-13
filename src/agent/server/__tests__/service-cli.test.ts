import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseServiceArgs, runServiceCli, ServiceUsageError } from '../service-cli'

/*
  各平台用**本平台**的路径与规则:这些用例校验的是真实路径的绝对性,而
  `mkdtempSync` 在 macOS 与 Windows 上给的都是**别名路径**(macOS 的 `/var/…` 底下是
  `/private/var/…`,Windows 给 8.3 短名 `C:\Users\RUNNER~1\…`)。跨平台喂给另一套路径规则
  (`--platform linux` 跑在 Windows 上)本来就是错配 —— 设备服务的安装参数是由**本机**路径填的。
  `realpathSync.native` 在 Windows 上取长名,在 POSIX 上把 `/var` 解成 `/private/var`。
*/
const WINDOWS = process.platform === 'win32'
const env = { platform: WINDOWS ? ('win32' as const) : ('linux' as const),
  nodePath: WINDOWS ? 'C:\\node\\node.exe' : '/opt/node/bin/node',
  binPath: WINDOWS ? 'C:\\ncw\\bin.mjs' : '/opt/ncw/bin.mjs', isAdmin: false }
let dir = ''
const lines: string[] = []
const io = { out: (line: string) => { lines.push(line) }, err: (line: string) => { lines.push(line) } }
beforeEach(() => { dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ncw-service-cli-'))); lines.length = 0 })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('service command line', () => {
  it('parses strictly and requires a user and data dir', () => {
    expect(parseServiceArgs(['plan', '--user', 'ncw', '--data-dir', '/d', '--advertise', 'a.lan', '--advertise', 'b.lan'], env).options.advertise).toEqual(['a.lan', 'b.lan'])
    for (const bad of [[], ['launch'], ['plan'], ['plan', '--user', 'ncw'], ['plan', '--data-dir', '/d'], ['plan', '--user', 'ncw', '--data-dir', '/d', '--bogus'],
      ['plan', '--user', 'ncw', '--data-dir', '/d', '--port', 'x'], ['plan', '--user', 'ncw', '--data-dir', '/d', '--platform', 'beos']]) {
      expect(() => parseServiceArgs(bad, env)).toThrow(ServiceUsageError)
    }
  })

  it('plan prints files and commands but writes nothing and runs nothing', () => {
    runServiceCli(['plan', '--user', 'ncw', '--data-dir', join(dir, 'data')], io, env)
    const text = lines.join('\n')
    expect(text).toContain('# file: /etc/systemd/system/ncw-agent.service')
    expect(text).toContain('systemctl enable ncw-agent')
    expect(text).toContain('systemctl start ncw-agent')
    expect(existsSync('/etc/systemd/system/ncw-agent.service')).toBe(false)
  })

  it('apply refuses to write system paths without administrator rights', () => {
    expect(() => runServiceCli(['apply', '--user', 'ncw', '--data-dir', join(dir, 'data')], io, env)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
  })

  it('apply writes under a chosen root with the planned mode and still enables/starts nothing', () => {
    runServiceCli(['apply', '--user', 'ncw', '--data-dir', join(dir, 'data'), '--root', join(dir, 'root')], io, env)
    const target = join(dir, 'root', 'etc/systemd/system/ncw-agent.service')
    expect(readFileSync(target, 'utf8')).toContain('User=ncw')
    expect(statSync(target).mode & 0o777).toBe(0o644)
    expect(lines.join('\n')).toContain('Nothing was enabled or started')
  })

  it('rejects a root user and prints uninstall commands', () => {
    expect(() => runServiceCli(['plan', '--user', 'root', '--data-dir', '/d'], io, env)).toThrowError(expect.objectContaining({ code: 'invalid_request' }))
    runServiceCli(['uninstall-plan', '--user', 'ncw', '--data-dir', '/d'], io, env)
    expect(lines.join('\n')).toContain('systemctl disable --now ncw-agent')
  })

  /*
    `--data-dir` 的绝对性按 `--platform` 判:Linux 的 unit 里写 `C:\…`、Windows 的 WinSW 配置里写
    `/var/lib/…` 都是注定起不来的,plan 阶段就该拦下,而不是等 systemd / 服务管理器报一个看不懂的错。
  */
  it('rejects a path that belongs to the other platform', () => {
    const linux = { ...env, platform: 'linux' as const }
    const windows = { ...env, platform: 'win32' as const }
    expect(() => runServiceCli(['plan', '--user', 'ncw', '--data-dir', 'C:\\ncw\\data'], io, linux))
      .toThrowError(expect.objectContaining({ code: 'invalid_request' }))
    expect(() => runServiceCli(['plan', '--user', 'ncw', '--data-dir', '/var/lib/ncw'], io, windows))
      .toThrowError(expect.objectContaining({ code: 'invalid_request' }))
    // 反过来:M 盘那样的 `/C:/…`(把 Windows 路径当 POSIX 路径拼出来)也拒掉。
    expect(() => runServiceCli(['plan', '--user', 'ncw', '--data-dir', '/C:/ncw/data'], io, linux))
      .toThrowError(expect.objectContaining({ code: 'invalid_request' }))
  })
})
