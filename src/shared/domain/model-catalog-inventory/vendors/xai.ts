import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, imageCapabilities, effortThinking, efforts } from '../helpers'

export const XAI: readonly BuiltinModelRecord[] = [
  // 需求：上新 grok-4.7，上下文窗口按官方口径为 500K（4.6 系列沿用 helpers 的
  // 200K 默认值未单独核实过，两者互不关联，别顺手把 4.6 也改成 500K）。
  model('xai', 'grok-4.7', 'Grok 4.7', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
    contextWindow: 500_000,
  }),
  model('xai', 'grok-4.6', 'Grok 4.6', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.5', 'Grok 4.5', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.3', 'Grok 4.3', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.20', 'Grok 4.20', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4', 'Grok 4', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('xai', 'grok-3', 'Grok 3', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('xai', 'grok-3-mini', 'Grok 3 Mini', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-2-vision-1212', 'Grok 2 Vision', {
    capabilities: visionCapabilities(),
  }),
  /*
   * 需求：补上 xAI Imagine 生图线（2026-09-25 从 docs.x.ai 官方 Imagine 价目与
   * 模型页核对）。原先 XAI 全表没有任何 modality: 'image' 的条目 —— 症状是
   * 「模型管理」里查不到 grok 的生图模型，登录/拉列表拿到 `grok-imagine-*` 时
   * `model-binding` 目录落空，别名被当成文本模型，图片页看不见它。
   *
   * ★ 计价按「张」（2.0 1K·low $0.04/张、image 输入 $0.01/张），TokenRates
   * 表达不了 —— 定价种子表里没有对应行，查不到价显示「—」，是既定失败方向，
   * 和豆包 seedream 那几行同理，别当成漏填。
   * ★ 生图/改图走 `POST /v1/images/generations|edits`（OpenAI 兼容），**不走**
   * chat/responses；edits 还要求 application/json 而非 multipart。
   */
  model('xai', 'grok-imagine-image-2.0', 'Grok Imagine Image 2.0', {
    modality: 'image',
    // 2.0 支持以图生图/改图（官方标了 image input 单价），故 vision 输入位打开
    capabilities: imageCapabilities({ vision: true, visionInput: true }),
    source: { url: 'https://docs.x.ai/developers/models/grok-imagine-image-2.0', fetchedAt: '2026-09-25' },
    verificationStatus: 'official-api',
  }),
  model('xai', 'grok-imagine-image-quality', 'Grok Imagine Image Quality', {
    modality: 'image',
    capabilities: imageCapabilities(),
    source: { url: 'https://docs.x.ai/developers/models', fetchedAt: '2026-09-25' },
    verificationStatus: 'official-api',
  }),
  model('xai', 'grok-imagine-image', 'Grok Imagine Image', {
    modality: 'image',
    capabilities: imageCapabilities(),
    source: { url: 'https://docs.x.ai/developers/models', fetchedAt: '2026-09-25' },
    verificationStatus: 'official-api',
  }),
]
