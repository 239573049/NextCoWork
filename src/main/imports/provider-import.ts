/**
 * 把三家(Claude Code / Codex / OpenCode)的提供商配置**归一成一种**可审核形状。
 *
 * ★ 归一在主进程一次做完:各家的 `wire_api` / `npm` / env 变量在这里换算成本应用的
 * `UpstreamProtocol`,渲染层拿到的就已经是能直接喂给 `customProviderDraft` 的字段。
 * 全程只读、只回元数据 —— 任何 token / apiKey 的**值**都不进返回(见 `provider-import` 类型)。
 */
import type { ImportSourceKind } from '../../shared/domain/import'
import type { ImportableProvider, ImportableProviders } from '../../shared/domain/provider-import'
import type { UpstreamProtocol } from '../../shared/domain/provider'
import { detectSource, listClaudeProviders } from './claude-code'
import { detectCodexSource, listCodexProviders } from './codex'
import {
  detectOpencodeSource,
  listOpencodeProviders,
  opencodeConfigDir,
  readOpencodeAuthNames,
  readOpencodeConfig
} from './opencode'

export async function collectImportableProviders(kind: ImportSourceKind, pickedDir?: string): Promise<ImportableProviders> {
  if (kind === 'codex') return fromCodex(pickedDir)
  if (kind === 'opencode') return fromOpencode(pickedDir)
  return fromClaude(pickedDir)
}

async function fromCodex(pickedDir?: string): Promise<ImportableProviders> {
  const src = await detectCodexSource(pickedDir)
  if (src.availability !== 'detected') return { kind: 'codex', available: false, configDir: '', providers: [] }
  const providers: ImportableProvider[] = (await listCodexProviders(src.configDir)).map((c) => ({
    sourceKey: `${c.profile}:${c.id}`,
    name: c.name,
    protocol: (c.wireApi === 'chat' ? 'openai-chat' : 'openai-responses') as UpstreamProtocol,
    baseUrl: c.baseUrl,
    models: c.defaultModel ? [c.defaultModel] : [],
    ...(c.defaultModel ? { defaultModel: c.defaultModel } : {}),
    hasLocalKey: c.envKey !== undefined || c.requiresOpenaiAuth === true,
    diagnostics: c.diagnostics
  }))
  return { kind: 'codex', available: true, configDir: src.configDir, providers }
}

async function fromOpencode(pickedDir?: string): Promise<ImportableProviders> {
  const src = await detectOpencodeSource(pickedDir)
  if (src.availability !== 'detected') return { kind: 'opencode', available: false, configDir: '', providers: [] }
  const { config, path } = await readOpencodeConfig(opencodeConfigDir())
  const authNames = await readOpencodeAuthNames(src.configDir)
  const providers: ImportableProvider[] = listOpencodeProviders(config, authNames, path).map((c) => ({
    sourceKey: c.id,
    name: c.name,
    protocol: c.protocol,
    baseUrl: c.baseUrl,
    models: c.models,
    ...(c.defaultModel ? { defaultModel: c.defaultModel } : {}),
    hasLocalKey: c.hasLocalKey,
    diagnostics: c.diagnostics
  }))
  return { kind: 'opencode', available: true, configDir: src.configDir, providers }
}

async function fromClaude(pickedDir?: string): Promise<ImportableProviders> {
  const src = await detectSource(pickedDir)
  if (src.availability !== 'detected') return { kind: 'claude-code', available: false, configDir: '', providers: [] }
  const providers: ImportableProvider[] = (await listClaudeProviders(src.configDir)).map((e) => ({
    sourceKey: 'claude-code',
    name: 'Claude Code',
    protocol: 'anthropic' as UpstreamProtocol,
    baseUrl: e.baseUrl,
    models: e.models,
    ...(e.defaultModel ? { defaultModel: e.defaultModel } : {}),
    hasLocalKey: e.hasLocalKey,
    diagnostics: []
  }))
  return { kind: 'claude-code', available: true, configDir: src.configDir, providers }
}
