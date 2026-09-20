import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities } from '../helpers'

export const MICROSOFT: readonly BuiltinModelRecord[] = [
  /*
   * 需求:用户点名收录微软 MAI-Code 1.1 Flash(2026-09-20)。当时查不到官方
   * 参数页,所以整行走保守默认:200K 窗口 / 16K 输出、vision 与 thinking 全关、
   * verificationStatus 停在 unverified。拿到官方文档后应把窗口、能力、
   * verificationStatus 一次补齐 —— 别只改其中一项,那会留下半新半旧的行。
   * source 只指向微软 AI Foundry 文档入口,不代表这行数据真的在该页核对过。
   *
   * 需求:定价与 GPT-5.6 Luna 完全一致(用户告知,2026-09-20,无官方页可核)。
   * 最初做法是 pricingModelId 映射到 `gpt-5.6-luna`;用户随后要求**独立设置、
   * 不依赖 Luna** —— 现在价目在 pricing-seed 的 MICROSOFT 段里自成一行,
   * 这里的 pricingModelId 走默认(= 自身 id),两条价目各自演进。
   * 「一致」只承诺录入时点:日后 Luna 调价不会自动带到这条。
   */
  model('microsoft', 'mai-code-1.1-flash', 'MAI-Code 1.1 Flash', {
    source: { url: 'https://learn.microsoft.com/azure/ai-foundry/', fetchedAt: '2026-09-20' },
  }),
  model('microsoft', 'phi-4', 'Phi-4', { capabilities: textCapabilities({ tools: false }) }),
  model('microsoft', 'phi-4-mini-instruct', 'Phi-4 Mini Instruct', {
    capabilities: textCapabilities(),
  }),
  model('microsoft', 'phi-4-multimodal-instruct', 'Phi-4 Multimodal Instruct', {
    capabilities: visionCapabilities({ audioInput: true }),
  }),
]
