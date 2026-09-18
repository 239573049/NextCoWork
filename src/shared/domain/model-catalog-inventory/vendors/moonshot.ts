import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, toggleThinking, effortThinking, OPENCODE_GO_SOURCE } from '../helpers'

/*
 * ★★ Coding Plan 的四个 Model ID 必须能命中这里的行(2026-09-18 修正)。
 * `kimi-coding` 预设种的是订阅端点自己的 id(`k3` / `k3-256k` / `kimi-for-coding` /
 * `kimi-for-coding-highspeed`,presets.ts 引了官方「可用模型」原话),而那张端点表
 * `supportsModelList` 拉不到别名元数据 —— 命不中目录时绑定会落到
 * IMPORTED_ALIAS_DEFAULTS(200K + thinking:false),表现是 k3 显示 200K、
 * 思考只剩「自动/关」。靠 alias 接回目录行,按量端点(kimi-k3 等)同吃一份元数据。
 */
export const MOONSHOT: readonly BuiltinModelRecord[] = [
  /*
   * ★ k3 = 1M 窗口 + effort 档位(低/高/最高,2026-09-18 核对修正;此前吃 200K
   * 兜底 + toggle)。coding 端点首选 Anthropic 形态,effort 在那条线上由
   * thinking-adapter 换算成 budget_tokens;openai-chat 形态发 reasoning_effort。
   */
  model('moonshot', 'kimi-k3', 'Kimi K3', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: effortThinking('reasoning_effort', 'max'),
    reasoningEfforts: ['low', 'high', 'max'],
    aliases: ['k3', 'moonshot/kimi-k3'],
  }),
  /* 官方「可用模型」表里的省额度形态:同一个 K3,窗口锁 256K。名字里的 256k
     按字面记 256_000(同 glm-4-32b-0414-128k 的记法)。 */
  model('moonshot', 'k3-256k', 'Kimi K3 256K', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 256_000,
    thinkingConfig: effortThinking('reasoning_effort', 'max'),
    reasoningEfforts: ['low', 'high', 'max'],
  }),
  model('moonshot', 'kimi-k2.5', 'Kimi K2.5', {
    capabilities: visionCapabilities({
      thinking: true,
      videoInput: true,
      tools: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('moonshot', 'kimi-k2.7-code', 'Kimi K2.7 Code', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    contextWindow: 1_000_000,
    thinkingConfig: toggleThinking('thinking'),
    aliases: ['kimi-for-coding'],
  }),
  model('moonshot', 'kimi-k2.6', 'Kimi K2.6', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('moonshot', 'kimi-k2.7-code-highspeed', 'Kimi K2.7 Code 高速版', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    contextWindow: 1_000_000,
    thinkingConfig: toggleThinking('thinking'),
    aliases: ['kimi-for-coding-highspeed'],
  }),
  model('moonshot', 'moonshot-v1-8k', 'Moonshot V1 8K', {
    capabilities: textCapabilities({ tools: false }),
    aliases: ['moonshot-v1-8k-vision-preview'],
  }),
  model('moonshot', 'moonshot-v1-32k', 'Moonshot V1 32K', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('moonshot', 'moonshot-v1-128k', 'Moonshot V1 128K', {
    capabilities: textCapabilities({ tools: false }),
  }),
]
