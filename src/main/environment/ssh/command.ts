import type { SshConnectionProfile } from '../../../shared/domain/environment'
import { EnvironmentError } from '../errors'

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
export function powershellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'` }

export function sshTargetArgs(profile: SshConnectionProfile): string[] {
  const target = profile.target
  if (typeof target?.host !== 'string' || target.host.startsWith('-') || !target.host || /[\s\0\r\n]/.test(target.host)) {
    throw new EnvironmentError('invalid-profile')
  }
  if (target.kind === 'config') {
    if (target.configFile?.includes('\0')) throw new EnvironmentError('invalid-profile')
    return [...(target.configFile ? ['-F', target.configFile] : []), target.host]
  }
  if (target.kind !== 'manual' || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
    || !target.username || /[\0\r\n]/.test(target.username)) throw new EnvironmentError('invalid-profile')
  for (const value of [target.identityFile, target.proxyJump]) {
    if (value?.includes('\0') || value?.includes('\n')) throw new EnvironmentError('invalid-profile')
  }
  return ['-p', String(target.port), '-l', target.username,
    ...(target.identityFile ? ['-i', target.identityFile] : []), ...(target.proxyJump ? ['-J', target.proxyJump] : []), target.host]
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