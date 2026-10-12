import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseServiceArgs, runServiceCli, ServiceUsageError } from '../service-cli'

const env = { platform: 'linux' as const, nodePath: '/opt/node/bin/node', binPath: '/opt/ncw/bin.mjs', isAdmin: false }
let dir = ''
const lines: string[] = []
const io = { out: (line: string) => { lines.push(line) }, err: (line: string) => { lines.push(line) } }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ncw-service-cli-')); lines.length = 0 })
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
})
