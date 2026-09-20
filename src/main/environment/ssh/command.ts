import { SSH_AUTH_METHODS, type SshConnectionProfile } from '../../../shared/domain/environment'
import { EnvironmentError } from '../errors'

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
export function powershellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'` }

export function sshTargetArgs(profile: SshConnectionProfile): string[] {
  const target = profile.target
  if (profile.authMethod !== undefined && !SSH_AUTH_METHODS.includes(profile.authMethod)) throw new EnvironmentError('invalid-profile')
  const preferred = profile.authMethod === 'password' || profile.authMethod === 'ask' ? 'password,keyboard-interactive'
    : profile.authMethod === 'key' ? 'publickey' : profile.authMethod === 'interactive' ? 'keyboard-interactive' : undefined
  const authArgs = preferred ? ['-o', `PreferredAuthentications=${preferred}`] : []
  if (typeof target?.host !== 'string' || target.host.startsWith('-') || !target.host || /[\s\0\r\n]/.test(target.host)) {
    throw new EnvironmentError('invalid-profile')
  }
  if (target.kind === 'config') {
    if (target.configFile?.includes('\0') || /[\0\r\n]/.test(target.identityFile ?? '')) throw new EnvironmentError('invalid-profile')
    return [...authArgs, ...(target.configFile ? ['-F', target.configFile] : []), ...(target.identityFile ? ['-i', target.identityFile] : []), target.host]
  }
  if (target.kind !== 'manual' || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
    || !target.username || /[\0\r\n]/.test(target.username)) throw new EnvironmentError('invalid-profile')
  for (const value of [target.identityFile, target.proxyJump]) {
    if (value?.includes('\0') || value?.includes('\n')) throw new EnvironmentError('invalid-profile')
  }
  return [...authArgs, '-p', String(target.port), '-l', target.username,
    ...(target.identityFile ? ['-i', target.identityFile] : []), ...(target.proxyJump ? ['-J', target.proxyJump] : []), target.host]
}

/**
 * known_hosts 里那条记录的名字。**必须和 OpenSSH 自己拼出来的一模一样**:
 * 默认端口用裸主机名,非默认端口用 `[host]:port`。
 */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${String(port)}`
}

/**
 * 把 ssh 改道到本地代理隧道上的那几个 `-o`。
 *
 * 需求:SSH 默认跟随系统代理(隧道本身见 `ssh/proxy.ts`)。ssh 连的是
 * `127.0.0.1:隧道端口`,但**主机密钥必须仍按原来的名字校验** —— 不设
 * `HostKeyAlias` 的话,ssh 会去 known_hosts 里找 `[127.0.0.1]:54321` 这种
 * 每次都不一样的名字,表现为每连一次就问一遍「确定要继续连接吗」,
 * 而且 `~/.ssh/known_hosts` 会被一堆随机端口的条目撑爆。
 * 顺带:`HostKeyAlias` 一设,ssh 也不再做 CheckHostIP —— 否则那个 IP 是 127.0.0.1。
 *
 * ★ 别名里用的是 **`ssh -G` 解析出的 HostName**,不是命令行上那个位置参数。
 * OpenSSH 的 known_hosts 是按 HostName 记的:配置型连接 `Host native-test /
 * HostName 10.0.0.2` 存下来的条目是 `10.0.0.2`。按位置参数拼会得到
 * `[native-test]:22`,在 `StrictHostKeyChecking yes` 下直接被判成陌生主机
 * (真实 sshd 用例抓到过:"No ED25519 host key is known for [native-test]:60003")。
 *
 * ★ 返回的参数要排在 `sshTargetArgs` **前面**。命令行上 `-o Port=` 和 `-p` 谁先谁赢
 * (实测 OpenSSH 10.3:`-p 2222 -o Port=3333` 得到 2222,反过来得到 3333),
 * 排在后面的话手动型连接配置的 `-p` 会把隧道端口顶掉,ssh 直接连去真实端口 ——
 * 表现为「代理设了但没生效」,且只在手动型连接上出现。
 *
 * @param resolvedHost `ssh -G` 给出的 hostname —— known_hosts 就是按它记录的
 * @param resolvedPort `ssh -G` 给出的真实端口,用来还原 known_hosts 里的端口修饰
 * @param aliasAlreadySet 用户自己配了 HostKeyAlias:那就是他的选择,不要覆盖
 */
export function proxyTunnelArgs(resolvedHost: string, resolvedPort: number, tunnelPort: number, aliasAlreadySet: boolean): string[] {
  return ['-o', 'HostName=127.0.0.1', '-o', `Port=${String(tunnelPort)}`,
    ...(aliasAlreadySet ? [] : ['-o', `HostKeyAlias=${knownHostsName(resolvedHost, resolvedPort)}`])]
}

export function powershellCommand(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

export function remoteCommand(os: string, shell: string, cwd: string, command: string): string {
  if ([shell, cwd, command].some((value) => value.includes('\0'))) throw new EnvironmentError('invalid-path')
  if (os === 'win32') {
    return powershellCommand(`$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${powershellQuote(cwd)}; `
      + `$global:LASTEXITCODE = 0; & ([ScriptBlock]::Create(${powershellQuote(command)})); `
      + `if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }; exit $LASTEXITCODE`)
  }
  return `cd -- ${shellQuote(cwd)} && exec ${shellQuote(shell)} -c ${shellQuote(command)}`
}

export function remoteExecutable(os: string, shell: string, cwd: string, command: string, args: readonly string[], env: Record<string, string> = {}): string {
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes('\0')) throw new EnvironmentError('invalid-profile')
  }
  if (Object.keys(env).length > 0) throw new EnvironmentError('invalid-profile', 'Use the process input channel for environment values')
  if (os === 'win32') {
    const environment = Object.entries(env).map(([name, value]) => `$env:${name}=${powershellQuote(value)};`).join(' ')
    return remoteCommand(os, shell, cwd, `${environment} & ${powershellQuote(command)} ${args.map(powershellQuote).join(' ')}`)
  }
  const environment = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ')
  return remoteCommand(os, shell, cwd, `exec env ${environment} ${[command, ...args].map(shellQuote).join(' ')}`)
}

export function remoteProcessRequest(os: string, shell: string, cwd: string, command: string, args: readonly string[], env: Record<string, string> = {}): { command: string; input?: string } {
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes('\0')) throw new EnvironmentError('invalid-profile')
  }
  if (Object.keys(env).length === 0) return { command: remoteExecutable(os, shell, cwd, command, args) }
  if (os === 'win32') {
    const script = `$source=[Console]::OpenStandardInput(); $header=[Collections.Generic.List[byte]]::new(); `
      + `while (($byte=$source.ReadByte()) -ge 0 -and $byte -ne 10) { if ($header.Count -gt 131072) { exit 125 }; $header.Add([byte]$byte) }; `
      + `$values=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Text.Encoding]::ASCII.GetString($header.ToArray()))) | ConvertFrom-Json; `
      + `$values.PSObject.Properties | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, [string]$_.Value, 'Process') }; `
      + `& ${[command, ...args].map(powershellQuote).join(' ')}; exit $LASTEXITCODE`
    return { command: remoteCommand(os, shell, cwd, script), input: `${Buffer.from(JSON.stringify(env)).toString('base64')}\n` }
  }
  const input = Object.entries(env).map(([name, value]) => {
    const octal = [...Buffer.from(value)].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('')
    return `${name}=$(printf '${octal}.'); ${name}=\${${name}%.}; export ${name};`
  }).join(' ')
  return { command: remoteCommand(os, '/bin/sh', cwd,
    `IFS= read -r ncw_environment || exit 125; eval "$ncw_environment"; exec ${[command, ...args].map(shellQuote).join(' ')}`), input: `${input}\n` }
}

export function remoteTerminalCommand(os: string, shell: string, cwd: string): string {
  if (os === 'win32') {
    const script = `Set-Location -LiteralPath ${powershellQuote(cwd)}`
    return `powershell.exe -NoLogo -NoExit -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  }
  return `cd -- ${shellQuote(cwd)} && exec ${shellQuote(shell)} -l`
}

export const POSIX_PROBE = `printf '%s\\0' "$(uname -s)" "$(uname -r)" "$(hostname)" "$(id -un)" "$HOME" "\${SHELL:-/bin/sh}"`
export const WINDOWS_PROBE = powershellCommand(`$ErrorActionPreference='Stop'; `
  + `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); `
  + `@{os='win32';osVersion=[Environment]::OSVersion.VersionString;hostname=[Environment]::MachineName;`
  + `username=[Environment]::UserName;home=$HOME;shell=(Get-Process -Id $PID).Path} | ConvertTo-Json -Compress`)
