/**
 * 内置定价种子表 —— 方案 §4.6。**纯数据,规则在 `pricing.ts`。**
 *
 * ★★ **这张表就是一份带日期的快照,不是真理。** 每一行都带 `source` 与 `fetchedAt`,
 * 界面上逐行显示,顶部固定一句「录入于 YYYY-MM,以供应商最终结算为准」——
 * 那不是免责套话,是这个设计的一部分:**价格会过期,但不会静默错。**
 *
 * 数据来自两份子代理调研报告(`~/.claude/plans/` 下,和方案同前缀):
 * `…-agent-a9c3ffd522bfa929f.md`(国际,1214 行,四方比对)与
 * `…-agent-a80a2d0ffcb64cbf5.md`(国内,DeepSeek 官方中英双页直读)。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ 三条录入纪律,以及它们各自砍掉了什么
 * ─────────────────────────────────────────────────────────────
 *
 * **1. 绝不编造数字。拿不准的宁可不收。**
 * 一个错的价格会让费用统计**静默失真**,而用户不会发现;一个缺失的价格显示成「—」,
 * 而且会出现在定价页顶部那张「用过但查不到定价」的表里 —— **两种错的可见性差着天。**
 * 所以这张表的取舍一律偏向「不收」。被砍掉的见文件末尾 `NOT_SEEDED`,
 * 每一条都写了为什么 —— 免得下一个人以为是漏了,顺手「补全」回来。
 *
 * **2. 两次搜索命中同一个数,不算交叉验证。**
 * 调研实证:摘要器会把「Gemini 3.7 Flash」和「3.1 Flash-Lite」的查询都返回
 * 3.8 Flash 那一段价格。得是两个**独立来源**(官方页 / 官方 PDF / LiteLLM / OpenRouter)。
 *
 * **3. 聚合源必须交叉校验,它们会错,而且错得看不出来。**
 * 光 OpenRouter 一家就抓到三个独立的错:Sonnet 4/4.5 挂着官方已取消的 >200K 加价档
 * (**凭空多收**)、`gpt-5.6-sol` 的价恰好是官方的一半(**少收一半**)、
 * Gemini 的缓存值是 Google 每小时存储费 ÷ 12(**量纲错,少收 12 倍**)。
 * 三个错方向还不一致,所以连「偏保守」都谈不上。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ 时段计费的录入方向:**基准价录空闲价,窗口录高峰 `multiplier: 2`**
 * ─────────────────────────────────────────────────────────────
 *
 * DeepSeek 官方的表述是反过来的 ——「空闲时段价格为高峰时段价格的一半」,
 * 照抄的话基准价 = 高峰价、窗口 = 高峰段 `multiplier: 1`,绕且反直觉。
 *
 * 两种录法**算出来完全一样**,选后者是因为**错的方向不一样**:
 * 万一时区或星期判断有 bug、窗口没命中,费用会落在**便宜**的那一侧 ——
 * 少算用户的钱,而不是多算。在一个「用户不会去核对」的数字上,
 * 这是唯一可接受的失败方向。
 *
 * 顺带这也符合「base 是常态」的直觉:高峰只有工作日 7 小时,
 * **其余时间(含整个周末)全是空闲价**,常态本来就是便宜那档。
 */
import type { Currency, ModelPricing, PriceTier, TokenRates } from './pricing'

/** 全表统一的采集日期。改数据时**同时**改它,否则界面上显示的日期是假的 */
const FETCHED_AT = '2026-09-04'

/** 单档(绝大多数模型)。多于一档才是阶梯,见下面 OpenAI / Gemini / xAI */
const one = (rate: TokenRates): readonly PriceTier[] => [{ upToInputTokens: null, rate }]

/**
 * 两档长上下文。**末档必须无上界** —— 上界写成具体数字的话,
 * 超过它的请求会一档都命不中,`priceOf` 返回 null,费用列变成「—」。
 */
const two = (upTo: number, low: TokenRates, high: TokenRates): readonly PriceTier[] => [
  { upToInputTokens: upTo, rate: low },
  { upToInputTokens: null, rate: high }
]

/**
 * 按厂商造行。`providerId` 的取值直接用 `presets.ts` 里的预设 id ——
 * 两张表用同一套 id,`findPricing` 才能拿运行时的 `provider.id` 查到覆盖价。
 */
const maker =
  (providerId: string | null, currency: Currency, source: string) =>
  (
    modelId: string,
    displayName: string,
    tiers: readonly PriceTier[],
    extra: Partial<ModelPricing> = {}
  ): ModelPricing => ({
    providerId,
    modelId,
    displayName,
    currency,
    modality: 'text',
    tiers,
    source,
    fetchedAt: FETCHED_AT,
    ...extra
  })

/* ══════════════════════════ Anthropic ══════════════════════════ */

/**
 * 证据强度最高的一组:**官方费率卡 PDF**,首页注明 Prices Effective 2026-08-31,
 * 子代理本机下载(HTTP 200 / 97,819 bytes / 14 页)后逐行提取核对,
 * 再与独立拉取的 OpenRouter 逐值吻合。
 *
 * ★ **Anthropic 当前没有长上下文溢价档。** 对 14 页全文检索过:`CONTEXT WINDOW`
 * 一列只出现 `All` 与 `≤200K` 两种取值,**全文档没有任何一行 `>200K`**。
 * 所以 13 个 SKU 全部是单档 —— 这与 OpenAI / Gemini / xAI 都不同。
 * (OpenRouter 至今还给 Sonnet 4/4.5 挂着 `min_prompt_tokens: 200000` 的加价档,
 * 那是陈旧数据,照它算会**凭空多收用户的钱**。以 PDF 为准。)
 *
 * ★★ **模型 ID 的可信度低于价格。** PDF 只给展示名("Claude Sonnet 4.6"),
 * 不给 API id。下面只有四个 id 是有一手依据的(运行环境直接给出):
 * `claude-fable-5-1` / `claude-opus-5` / `claude-sonnet-5` /
 * `claude-haiku-4-5-20251001` —— 注意**版本号里的点写成连字符**,
 * 且 4.5 世代带日期后缀而新世代不带。其余九个按这条已证实的构词法推出来。
 *
 * 推错了的代价是**查不到定价**(费用列「—」,并进定价页顶部那张待补表),
 * **不是算错价** —— 而且同族价格本来就一样(Opus 4.5–4.8 全是 5/25)。
 * 所以这里推比不收好:两者的失败表现相同,推对了还能省用户一次手工录入。
 */
const anth = maker(
  null,
  'USD',
  'https://www-cdn.anthropic.com/files/4zrzovbb/website/9e03129acc36d31970777d336f969bb53dc84355.pdf'
)

/** 五列一次写全,顺序同费率卡:输入 / 输出 / 5m 写 / 1h 写 / 读 */
const claude = (
  input: number,
  output: number,
  w5m: number,
  w1h: number,
  read: number
): TokenRates => ({
  input,
  output,
  cacheRead: read,
  cacheWrite: w5m,
  cacheWrite1h: w1h
})

const ANTHROPIC: readonly ModelPricing[] = [
  // ★ 这两行的缓存读是 $0.25(0.025×输入),不是别人的 0.1× —— 见文件头
  anth('claude-mythos-5-1', 'Claude Mythos 5.1', one(claude(10, 50, 12.5, 20, 0.25))),
  anth('claude-fable-5-1', 'Claude Fable 5.1', one(claude(10, 50, 12.5, 20, 0.25))),
  anth('claude-opus-5', 'Claude Opus 5', one(claude(5, 25, 6.25, 10, 0.5))),
  anth('claude-sonnet-5', 'Claude Sonnet 5', one(claude(2, 10, 2.5, 4, 0.2))),
  // 上一代同价位,但缓存读贵 4 倍($1.00)—— 正是「存绝对价、不存倍率」的证据
  anth('claude-mythos-5', 'Claude Mythos 5', one(claude(10, 50, 12.5, 20, 1.0))),
  anth('claude-fable-5', 'Claude Fable 5', one(claude(10, 50, 12.5, 20, 1.0))),
  anth('claude-opus-4-8', 'Claude Opus 4.8', one(claude(5, 25, 6.25, 10, 0.5))),
  anth('claude-opus-4-7', 'Claude Opus 4.7', one(claude(5, 25, 6.25, 10, 0.5))),
  anth('claude-opus-4-6', 'Claude Opus 4.6', one(claude(5, 25, 6.25, 10, 0.5))),
  anth('claude-sonnet-4-6', 'Claude Sonnet 4.6', one(claude(3, 15, 3.75, 6, 0.3))),
  anth('claude-opus-4-5', 'Claude Opus 4.5', one(claude(5, 25, 6.25, 10, 0.5))),
  anth('claude-sonnet-4-5', 'Claude Sonnet 4.5', one(claude(3, 15, 3.75, 6, 0.3))),
  anth('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', one(claude(1, 5, 1.25, 2, 0.1)))
]

/* ══════════════════════════ OpenAI ══════════════════════════ */

/**
 * ★ **长上下文阈值是 272K,而且倍率不对称:输入 / 缓存读 / 缓存写 ×2,输出 ×1.5。**
 * 这条被 LiteLLM 与 OpenRouter 两份原始 JSON 逐值验证一致。
 * 「一个模型一个折扣系数」的设计在这里就崩了 —— 所以 `PriceTier.rate` 是一整套费率。
 *
 * ★ **GPT-5.6 世代开始收缓存写入费(1.25× 输入)。** 老型号(4.1 / 4o / o 系列)
 * 仍是「缓存读打折、写入不收费」的经典模式 —— 那些行**不写 `cacheWrite`**,
 * 而不是填 0(填 0 会被算成「写入免费」,是个具体的错)。
 *
 * 只给现代四款(astra / sol / terra / luna)配 272K 双档:它们的缓存写入价
 * 被双源确认过,是报告里明确归入新计费结构的那一批。老型号没有逐款确认过
 * 是否适用 272K 档,按单档收 —— 猜错的方向是**少收**,符合文件头第 1 条。
 */
const oai = maker(null, 'USD', 'https://openai.com/api/pricing')

const OPENAI: readonly ModelPricing[] = [
  oai(
    'gpt-6-astra',
    'GPT-6 Astra',
    two(
      272_000,
      { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
      { input: 20, output: 75, cacheRead: 2.0, cacheWrite: 25 }
    )
  ),
  /*
    ★ 收的是**促销价**($4/$20),不是业务页上那个 $5/$30 的标准价 ——
    收「实际被扣的那个」。促销据官方口径**至少**持续到 2026-11-21,
    是个下界不是上界,所以这里**不写 `effectiveUntil`**:
    写了就等于替 OpenAI 宣布 11-22 涨价,而那是我们编的。
    促销真的结束时这一行会偏低,靠 `fetchedAt` 和顶部那句提示兜住。
  */
  oai(
    'gpt-5.6-sol',
    'GPT-5.6 Sol(促销价,标准价 $5/$30)',
    two(
      272_000,
      { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
      { input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }
    ),
    { source: 'https://openai.com/api/pricing#promo-until-2026-11-21' }
  ),
  oai(
    'gpt-5.6-terra',
    'GPT-5.6 Terra',
    two(
      272_000,
      { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
      { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }
    )
  ),
  oai(
    'gpt-5.6-luna',
    'GPT-5.6 Luna',
    two(
      272_000,
      { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
      { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }
    )
  ),
  oai('gpt-5.5', 'GPT-5.5', one({ input: 5, output: 30, cacheRead: 0.5 })),
  oai('gpt-5.5-pro', 'GPT-5.5 Pro', one({ input: 30, output: 180 })),
  oai('gpt-5.4', 'GPT-5.4', one({ input: 2.5, output: 15, cacheRead: 0.25 })),
  oai('gpt-5.4-mini', 'GPT-5.4 mini', one({ input: 0.75, output: 4.5, cacheRead: 0.075 })),
  oai('gpt-5.4-nano', 'GPT-5.4 nano', one({ input: 0.2, output: 1.25, cacheRead: 0.02 })),
  oai('gpt-5.4-pro', 'GPT-5.4 Pro', one({ input: 30, output: 180 })),
  oai('gpt-5.2', 'GPT-5.2', one({ input: 1.75, output: 14, cacheRead: 0.175 })),
  oai('gpt-5.2-pro', 'GPT-5.2 Pro', one({ input: 21, output: 168 })),
  oai('gpt-5.1', 'GPT-5.1', one({ input: 1.25, output: 10, cacheRead: 0.125 })),
  oai('gpt-5', 'GPT-5', one({ input: 1.25, output: 10, cacheRead: 0.125 })),
  oai('gpt-5-mini', 'GPT-5 mini', one({ input: 0.25, output: 2, cacheRead: 0.025 })),
  oai('gpt-5-nano', 'GPT-5 nano', one({ input: 0.05, output: 0.4, cacheRead: 0.005 })),
  oai('gpt-5-pro', 'GPT-5 Pro', one({ input: 15, output: 120 })),
  oai('gpt-4.1', 'GPT-4.1', one({ input: 2, output: 8, cacheRead: 0.5 })),
  oai('gpt-4.1-mini', 'GPT-4.1 mini', one({ input: 0.4, output: 1.6, cacheRead: 0.1 })),
  oai('gpt-4.1-nano', 'GPT-4.1 nano', one({ input: 0.1, output: 0.4, cacheRead: 0.025 })),
  oai('gpt-4o', 'GPT-4o', one({ input: 2.5, output: 10, cacheRead: 1.25 })),
  oai('gpt-4o-mini', 'GPT-4o mini', one({ input: 0.15, output: 0.6, cacheRead: 0.075 })),
  oai('o1', 'o1', one({ input: 15, output: 60, cacheRead: 7.5 })),
  oai('o1-pro', 'o1-pro', one({ input: 150, output: 600 })),
  oai('o3', 'o3', one({ input: 2, output: 8, cacheRead: 0.5 })),
  oai('o3-pro', 'o3-pro', one({ input: 20, output: 80 })),
  oai('o3-mini', 'o3-mini', one({ input: 1.1, output: 4.4, cacheRead: 0.55 })),
  oai('o4-mini', 'o4-mini', one({ input: 1.1, output: 4.4, cacheRead: 0.275 })),
  oai('gpt-4-turbo-2024-04-09', 'GPT-4 Turbo', one({ input: 10, output: 30 })),
  oai('gpt-4-0613', 'GPT-4', one({ input: 30, output: 60 })),
  oai('gpt-3.5-turbo', 'GPT-3.5 Turbo', one({ input: 0.5, output: 1.5 }))
]

/* ══════════════════════════ Google Gemini ══════════════════════════ */

/**
 * ★ **只收 Pro 两款。** Google 官方定价页在采集环境不可达(curl HTTP 000,
 * 子代理独立复现),这两行是靠 LiteLLM 与 OpenRouter **两个独立来源逐值吻合**
 * 才敢收的 —— 正好卡在文件头第 2 条的及格线上。
 *
 * Flash 全系不收,两个理由叠加(见 `NOT_SEEDED`)。
 *
 * ★ 阈值是 **200K,不是 128K** —— 128K 是 Gemini 1.5 时代的,现行世代统一 200K。
 * 倍率:输入 ×2、缓存读 ×2、**输出 ×1.5**(又一处不对称)。
 * **只有 Pro 系列分档,Flash 全系不分档。**
 *
 * ★ 缓存写入**故意不写**:Google 是按「每百万 token 每小时」收**存储费**,
 * 那是一条量纲不同的计费线(费用 ∝ token × 持有小时数),塞进 `cacheWrite`
 * 只在「恰好持有 5 分钟」时才对,持有 1 小时会低估 12 倍。方案 §4.5 明确不建模它。
 */
const gem = maker(
  null,
  'USD',
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@v1.99.0/model_prices_and_context_window.json'
)

const GEMINI: readonly ModelPricing[] = [
  gem(
    'gemini-2.5-pro',
    'Gemini 2.5 Pro',
    two(
      200_000,
      { input: 1.25, output: 10, cacheRead: 0.125 },
      { input: 2.5, output: 15, cacheRead: 0.25 }
    )
  ),
  gem(
    'gemini-3.1-pro-preview',
    'Gemini 3.1 Pro',
    two(200_000, { input: 2, output: 12, cacheRead: 0.2 }, { input: 4, output: 18, cacheRead: 0.4 })
  )
]

/* ══════════════════════════ xAI Grok ══════════════════════════ */

/**
 * 规则最干净的一家:**统一阈值 200K,>200K 档所有计费项一律 ×2** ——
 * 唯一一家倍率在各计费项之间完全统一的厂商。LiteLLM 与 OpenRouter 逐值吻合。
 *
 * ★ xAI 的文档正是 `pricing.ts` 里「整单重定价」那条规则的出处,
 * 也点明了**缓存 token 计入阈值判定**:一个很大的缓存前缀会把请求推过 200K,
 * 导致整单涨价 —— 和「缓存应该省钱」的直觉正好相反。
 */
const xai = maker(
  null,
  'USD',
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@v1.99.0/model_prices_and_context_window.json'
)

const XAI: readonly ModelPricing[] = [
  xai(
    'grok-4.3',
    'Grok 4.3',
    two(
      200_000,
      { input: 1.25, output: 2.5, cacheRead: 0.2 },
      { input: 2.5, output: 5, cacheRead: 0.4 }
    )
  ),
  xai(
    'grok-4.5',
    'Grok 4.5',
    two(200_000, { input: 2, output: 6, cacheRead: 0.3 }, { input: 4, output: 12, cacheRead: 0.6 })
  ),
  xai(
    'grok-4.6',
    'Grok 4.6',
    two(200_000, { input: 2, output: 6, cacheRead: 0.5 }, { input: 4, output: 12, cacheRead: 1.0 })
  )
]

/* ══════════════════════════ 智谱 / Z.AI(USD) ══════════════════════════ */

/**
 * ★ **只收美元价,挂在 `zai`(国际站)这个预设 id 下。**
 * 官方国际站页面明示 "All prices are in USD";而
 * `open.bigmodel.cn` 的人民币价走需要 `Authorization` 的接口,匿名一律
 * `1001 Header中未收到Authorization参数` —— **人民币价格完全未核实,一个数字都不收。**
 * 所以国内站预设 `zhipu` 下没有任何种子价,费用列显示「—」。
 *
 * ★ 官方缓存文档写「通常为标准价格的 50%」,但价目表实际是输入价的 ~19%
 * ($0.26 vs $1.4)—— **以表为准**,这也是不照公式生成的又一个例子。
 *
 * ★ 智谱确实有峰谷定价,但**只作用于 GLM Coding Plan 订阅**(按积分计),
 * 与 API 现付无关,**不要混进 `windows`**。
 */
const glm = maker('zai', 'USD', 'https://docs.z.ai/guides/overview/pricing.md')

const ZHIPU: readonly ModelPricing[] = [
  glm('glm-5.3', 'GLM-5.3', one({ input: 1.4, output: 4.4, cacheRead: 0.26 })),
  glm('glm-5.2', 'GLM-5.2', one({ input: 1.4, output: 4.4, cacheRead: 0.26 })),
  glm('glm-5.1', 'GLM-5.1', one({ input: 1.4, output: 4.4, cacheRead: 0.26 })),
  glm('glm-5', 'GLM-5', one({ input: 1, output: 3.2, cacheRead: 0.2 })),
  glm('glm-4.7', 'GLM-4.7', one({ input: 0.6, output: 2.2, cacheRead: 0.11 })),
  glm('glm-4.6', 'GLM-4.6', one({ input: 0.6, output: 2.2, cacheRead: 0.11 })),
  glm('glm-4.5', 'GLM-4.5', one({ input: 0.6, output: 2.2, cacheRead: 0.11 })),
  glm('glm-4.5-air', 'GLM-4.5-Air', one({ input: 0.2, output: 1.1, cacheRead: 0.03 })),

  /*
    ★★ **全表唯一一处用上 `effectiveFrom` / `effectiveUntil` 的地方,而且它是有据可查的**:
    官方页写明 GLM-5.3-Flash 的促销价于 **2026-09-09 24:00(UTC+8)** 结束,并同时印出原价。
    两行、日期区间不重叠 —— 到点自动切换,而不是等用户某天发现统计全错。

    (Gemini Flash 那个「2027-01-01 起翻倍」的公告也是同一形状,但它只经搜索检索
    未直接核实,所以那几行整个不收 —— 见 `NOT_SEEDED`。)

    ⚠️ 日期是**按 UTC+8 的自然日**记的,而 `effectiveAt` 比较的是 UTC 日期串。
    9 月 9 日 24:00(UTC+8)= 9 月 9 日 16:00 UTC,落在 UTC 的 9 月 9 日内,
    所以按 UTC 日期切在 09-09 / 09-10 之间只差最后那 8 小时 —— 那 8 小时会**按原价算**,
    偏贵。这是本表唯一一处方向偏贵的近似,记在这里免得被当成 bug 查。
  */
  glm(
    'glm-5.3-flash',
    'GLM-5.3-Flash(促销价)',
    one({ input: 0.075, output: 0.25, cacheRead: 0.015 }),
    {
      effectiveUntil: '2026-09-09'
    }
  ),
  glm('glm-5.3-flash', 'GLM-5.3-Flash', one({ input: 0.15, output: 0.5, cacheRead: 0.03 }), {
    effectiveFrom: '2026-09-10'
  })
]

/* ══════════════════════════ DeepSeek(时段计费) ══════════════════════════ */

/**
 * ★ **全表唯一用上 `windows` 的一组。** 官方中英双页直读、互相印证,
 * 再与 OpenRouter 的逐窗口 `overrides` 吻合 —— 证据强度和 Anthropic 并列最高。
 *
 * 官方原文(抄在这里,因为下一个人也会想当然):
 *
 * > 英文:*"Off-peak rates are half of the peak rates. Peak hours are
 * > **01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday**
 * > (all other hours are off-peak)."*
 * >
 * > 中文:「空闲时段价格为高峰时段价格的一半。高峰时段为**北京时间周一至周五
 * > 9:00 - 12:00、14:00 - 18:00**(其余为空闲时段)。」
 *
 * 两版换算后自洽(北京 = UTC+8)。**流传甚广的「16:30–00:30 UTC 错峰优惠」是错的** ——
 * 那来自第三方站点,且「错峰优惠」这个方案本身已于 2026-08-16 被「高峰/空闲」取代,
 * 当前官方页上「错峰」二字出现 0 次。
 *
 * ★★ **必须有星期维度。** 高峰只在**周一至周五**,周末整个是空闲价。
 * 少了 `daysOfWeek`,「周六凌晨 2 点」会被算成高峰 —— 贵一倍,而且没人会发现。
 *
 * ★ 折扣**同时作用于输入、输出、缓存命中三项,统一 5 折**(用实际报价表反算验证过是
 * 精确 2 倍关系),所以一个 `multiplier: 2` 就够,不必写整套 `rates`。
 *
 * ★ **DeepSeek 没有缓存写入费** —— 价目表只有「命中 / 未命中」两档输入价。
 * 所以 `cacheWrite` **缺省不写**,不是填 0。
 *
 * 币种:只收人民币(官方中文页)。**不做换算** —— 实测同一张表内部就有两个不同的
 * 隐含汇率(6.818 与 7.143),两套价格是各自独立定价、独立取整的,
 * 任何自动换算都必然与至少一部分官方数字对不上。美元账户请用 provider 覆盖价。
 */
const PEAK_WINDOWS = [
  {
    timezone: 'UTC',
    daysOfWeek: [1, 2, 3, 4, 5],
    start: '01:00',
    end: '04:00',
    multiplier: 2,
    label: '高峰时段(北京时间 09:00–12:00)'
  },
  {
    timezone: 'UTC',
    daysOfWeek: [1, 2, 3, 4, 5],
    start: '06:00',
    end: '10:00',
    multiplier: 2,
    label: '高峰时段(北京时间 14:00–18:00)'
  }
] as const

const ds = maker('deepseek', 'CNY', 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing')

/** 基准 = **空闲价**(见文件头那段论证) */
const DEEPSEEK: readonly ModelPricing[] = [
  ds('deepseek-v4-flash', 'DeepSeek V4 Flash', one({ input: 1.5, output: 4.5, cacheRead: 0.05 }), {
    windows: PEAK_WINDOWS
  }),
  ds('deepseek-v4-pro', 'DeepSeek V4 Pro', one({ input: 4.5, output: 13.5, cacheRead: 0.15 }), {
    windows: PEAK_WINDOWS
  }),
  ds(
    'deepseek-v4-flash-vision-exp',
    'DeepSeek V4 Flash Vision(实验)',
    one({ input: 1.5, output: 4.5, cacheRead: 0.05 }),
    { windows: PEAK_WINDOWS }
  )
]

/* ══════════════════════════ Moonshot / Kimi ══════════════════════════ */

/**
 * 官方中英双站直读。**上下文分档已彻底取消** —— 旧的 `moonshot-v1-8k/32k/128k`
 * 三个 SKU 不再存在,现在是每模型单一价 + 缓存命中/未命中输入价二分,
 * 结构和 DeepSeek 相同(但没有时段计费)。缓存自动、无写入费、无存储费。
 *
 * ★ 中美两站各录各的,**挂在两个不同的预设 id 下**(`moonshot` / `moonshot-global`)——
 * 这正是 `ModelPricing.providerId` 存在的理由。又一个「不是换算关系」的实证:
 * k3 的中美比值恒为 6.667,而 k2.6 是 6.875 / 6.84 / 6.75。
 */
const kimiCny = maker('moonshot', 'CNY', 'https://platform.moonshot.cn/docs/pricing')
const kimiUsd = maker('moonshot-global', 'USD', 'https://platform.moonshot.ai/docs/pricing')

const MOONSHOT: readonly ModelPricing[] = [
  kimiCny('kimi-k3', 'Kimi K3', one({ input: 20, output: 100, cacheRead: 2.0 })),
  kimiCny('kimi-k2.6', 'Kimi K2.6', one({ input: 6.5, output: 27, cacheRead: 1.1 })),
  kimiCny('kimi-k2.7-code', 'Kimi K2.7 Code', one({ input: 6.5, output: 27, cacheRead: 1.3 })),
  // `-highspeed` 是**同一个模型**卖吞吐,整体 2 倍价
  kimiCny(
    'kimi-k2.7-code-highspeed',
    'Kimi K2.7 Code 高速版',
    one({ input: 13, output: 54, cacheRead: 2.6 })
  ),

  kimiUsd('kimi-k3', 'Kimi K3', one({ input: 3.0, output: 15, cacheRead: 0.3 })),
  kimiUsd('kimi-k2.6', 'Kimi K2.6', one({ input: 0.95, output: 4.0, cacheRead: 0.16 })),
  kimiUsd('kimi-k2.7-code', 'Kimi K2.7 Code', one({ input: 0.95, output: 4.0, cacheRead: 0.19 })),
  kimiUsd(
    'kimi-k2.7-code-highspeed',
    'Kimi K2.7 Code 高速版',
    one({ input: 1.9, output: 8.0, cacheRead: 0.38 })
  )
]

/* ══════════════════════════ 阿里百炼 Qwen ══════════════════════════ */

/**
 * ★ **只收无阶梯的那几款。** 官方中文页直读,证据够;但有阶梯的那些收不了:
 * 档位边界写作「0–32K / 32K–128K」,**「K」是 1000 还是 1024 无法从页面确定**,
 * 而边界猜错会让恰好落在附近的请求整单按错档重算(整单重定价,不是分段)。
 * 另外 `qwen-plus` / `qwen-turbo` 的输出价**按思考/非思考模式分两列**,
 * 而 `TokenRates` 里没有这一维 —— 硬选一列就是编。
 *
 * ★ 缓存也不收:Qwen 的缓存价是**以输入价的百分比**表达的(显式创建 ~125%、
 * 命中 ~10%;隐式创建 100%、命中 ~20%),而我们存绝对价。两套缓存机制取哪套
 * 取决于用户怎么调,应用无从得知。
 */
const qwen = maker('dashscope', 'CNY', 'https://help.aliyun.com/zh/model-studio/model-pricing')

const QWEN: readonly ModelPricing[] = [
  qwen('qwen3.8-max', 'Qwen3.8-Max', one({ input: 12, output: 36 })),
  qwen('qwen-max', 'Qwen-Max', one({ input: 2.4, output: 9.6 })),
  qwen('qwen-long', 'Qwen-Long', one({ input: 0.5, output: 2 }))
]

/**
 * 种子表全量。**顺序 = 界面默认顺序**(国际在前、国内在后,各自按厂商聚簇)。
 */
export const PRICING_SEED: readonly ModelPricing[] = [
  ...ANTHROPIC,
  ...OPENAI,
  ...GEMINI,
  ...XAI,
  ...ZHIPU,
  ...DEEPSEEK,
  ...MOONSHOT,
  ...QWEN
]

/**
 * ★★ **故意没收进来的东西,以及为什么。**
 *
 * 写成一份可导出的清单而不是散落的注释,是因为「这一条是漏了还是砍了」
 * 只能由记录回答 —— 而**下一个人默认会假设是漏了**,然后「顺手补全」回来。
 *
 * 界面上不显示它,它的读者是改这张表的人。
 */
export const NOT_SEEDED: readonly { what: string; why: string }[] = [
  {
    what: 'Mistral 全系(8 款)',
    why: '**仅 OpenRouter 单源**,未与官方页比对。而 OpenRouter 在本次调研里被抓到三个独立的价格错(其中一个是旗舰模型上 2 倍的误差),单源不够 —— 文件头第 2、3 条。'
  },
  {
    what: 'Gemini Flash 全系(2.5 / 3 / 3.1-lite / 3.5 / 3.6 / 3.7 / 3.8)',
    why: '两个理由叠加:① 摘要器实证会把 3.7 Flash 与 3.1 Flash-Lite 的查询都返回 3.8 Flash 那一段价格,报告里这几款本来就挤在同一行,正是混淆的签名;② 「介绍价 2026-12-31 结束、2027-01-01 翻倍」的公告仅经搜索检索、未直接核实 —— 照它写日期区间等于替 Google 宣布涨价。Pro 两款有双源吻合,所以收。'
  },
  {
    what: 'MiniMax 全系',
    why: '价格本身官方双页已核实(M3 单一阈值 512K,有缓存写入费 ¥2.625),但**模型 ID 的大小写无法确定**(官方页写 "MiniMax-M3",聚合平台写 `minimax-m3`)。ID 错 = 永远命不中定价,而这张表里没有第二个来源能对。'
  },
  {
    what: '豆包 Doubao 全系',
    why: '独有**第二个计费维度**:部分 SKU 按「输出长度」分档(200 token 阈值,输入价不变而输出价从 ¥2 跳到 ¥8)。`PriceTier` 只按输入 token 分档,表达不了。另外火山用「接入点 ID」而不是模型名,种子表也对不上。'
  },
  {
    what: '智谱人民币价格',
    why: '`open.bigmodel.cn` 的价格接口要 `Authorization`,匿名探测一律 `1001 Header中未收到Authorization参数`,文档站索引里也没有价格页 —— **一个数字都没核实到**。美元价(国际站 docs.z.ai)已收,挂在 `zai` 下。'
  },
  {
    what: 'Qwen 的阶梯款(qwen3-max / qwen-plus / qwen-flash / qwen3.7-flash)与缓存价',
    why: '档位边界的「K」是 1000 还是 1024 无法确定,而阶梯是整单重定价、边界猜错就整单算错;`qwen-plus` / `qwen-turbo` 的输出价还按思考/非思考分两列,`TokenRates` 没有这一维。'
  },
  {
    what: 'grok-4.20 系列 / grok-build-0.1',
    why: '仅见于 OpenRouter,LiteLLM 里没有 —— 单源。4.3/4.5/4.6 是双源吻合才收的。'
  },
  {
    what: '所有订阅制方案(Kimi / GLM / Z.AI Coding Plan、OpenCode Go)',
    why: '按积分或按月额度计,不是按 token 计费,和这张表不是同一种东西。方案 §5.3:订阅额度不计入总费用。'
  },
  {
    what: '批处理 / 服务等级 / 区域倍率',
    why: '方案 §4.5 明确不建模。我们不发批处理请求;区域与优先级是**账户级**设置,应用无从得知。需要的用户走 provider 级覆盖价。'
  },
  {
    what: '按小时计费的缓存存储(Google / 豆包 / 智谱)',
    why: '方案 §4.5:要算它得知道缓存条目建于何时、持有了多久,而流式响应里根本没有这个信息,硬凑一个持有时长等于编数字。★ OpenRouter 就是这么错的 —— 它把 Google 的每小时费率 ÷ 12 塞进了一次性写入费字段,**量纲错**,持有 1 小时会少收 12 倍。'
  },
  {
    what: 'Claude Managed Agents 的 $0.08 / session-hour',
    why: '一条**与 token 无关**的计费线。我们的统计只有 token,这部分本来就会漏算 —— 收进来也算不出。'
  }
]
