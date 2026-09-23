import type { BuiltinModelRecord } from '../types'
import { model, visionCapabilities, budgetThinking } from '../helpers'

/*
 * ★★ 每一行都显式写 `contextWindow: 1_000_000`(2026-09-18 核对修正)。
 * 在这之前全部 16 行吃 `model()` 的 200_000 兜底(helpers.ts),表现是圆环分母、
 * 设置页窗口列、「最大上下文」开关的判据(`supportsMaxContext`)全按 200K 算 ——
 * 窗口被静默压小,而且没有任何报错指向目录。费率卡对超 200K 不加价
 * (pricing-seed.ts 文件头的 PDF 证据),所以不需要配套的长上下文价格档。
 * (2026-09-23 新增 claude-opus-5-5 后共 17 行,同样显式写 1M,不破这条不变式。)
 */
export const ANTHROPIC: readonly BuiltinModelRecord[] = [
  /*
   * 需求:2026-09-23 用户点名收录 Opus 5.5,连同其费率一起给的(见 pricing-seed
   * 的 Anthropic 段)。窗口 / 思考预算没有独立依据,按同族 Opus 5 推 ——
   * 本文件的 1M + Opus 64K budget 就是那条族内规律,推错的方向是
   * 「预算给多/给少一次思考」,不是窗口被压小。
   */
  model('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-5', 'Claude Opus 5', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-mythos-5-1', 'Claude Mythos 5.1', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
    /*
     * ★ 点号拼写是预设侧真实在用的形式(anthropic / openrouter 两条预设的
     * suggestedModels),不登记的话这两处错过目录:元数据走兜底值,
     * openai 族供应商上的协议钉也不命中 —— findBuiltinModel 的匹配
     * 认不了 `5.1` 与 `5-1` 的差别。
     */
    aliases: ['claude-fable-5.1'],
  }),
  model('anthropic', 'claude-mythos-5', 'Claude Mythos 5', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-fable-5', 'Claude Fable 5', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
    // ★ 点号别名,理由同 claude-fable-5-1 那条(anthropic 预设在用它)
    aliases: ['claude-opus-4.8'],
  }),
  model('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 16_000),
  }),
  model('anthropic', 'claude-3-7-sonnet-latest', 'Claude 3.7 Sonnet', {
    capabilities: visionCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: budgetThinking('thinking.budget_tokens', 16_000),
    aliases: ['claude-3-7-sonnet-20250219'],
  }),
  model('anthropic', 'claude-3-5-sonnet-latest', 'Claude 3.5 Sonnet', {
    capabilities: visionCapabilities(),
    contextWindow: 1_000_000,
    aliases: ['claude-3-5-sonnet-20241022'],
  }),
  model('anthropic', 'claude-3-5-haiku-latest', 'Claude 3.5 Haiku', {
    capabilities: visionCapabilities(),
    contextWindow: 1_000_000,
    aliases: ['claude-3-5-haiku-20241022'],
  }),
]
