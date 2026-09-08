import { describe, expect, it } from 'vitest'
import { BUILTIN_MODEL_CATALOG } from '../model-catalog-inventory'
import { modelSupportsTools } from '../model-runtime'

/**
 * `capabilities.tools` 的证据表 —— **这一列的取值来源,以及它为什么值得单独一个文件。**
 *
 * ★★ **这一列错了不会报错,只会让 Agent 变哑。**
 * `agent-session.ts` 在下发工具前有一道门:`modelSupportsTools(alias) ? available : []`。
 * 模型标了 `tools: false`,整份工具快照就被换成空数组 —— 请求体里连 `tools` 字段都没有,
 * 上游一切正常、日志一切正常,只是模型开始说「请提供文件路径」而不是自己去读。
 * 这个症状指向的是「模型不聪明」,没有任何一条线索指向能力表,所以它能存活很久。
 *
 * ★ **它确实存活了很久。** 这张表原本默认 `tools: false`,而绝大多数行从没覆盖过它:
 * ernie-5.0 有、ernie-5.1 没有;glm-5.3-flash 有、glm-5.3 没有;全部 GPT 和全部 Claude
 * 一个都没有。分布是噪声,不是矩阵 —— 说明它从来不是「查证后填的」,而是「谁顺手写了才有」。
 *
 * 所以默认值翻成了 `true`(见 `model-catalog-inventory.ts` 的 `textCapabilities`),
 * 而**每一个覆盖回 `false` 的行都要在这里留下依据**。翻默认值只解决了当下,
 * 这个文件解决的是下一次:没有它,过两个月又会有人凭印象把某一行改回去。
 *
 * ★ 判据分两张表,**「查过,确实不支持」和「查不到」不是一回事**:
 * 前者(`DOCUMENTED_NO_TOOLS`)被断言必须是 `false`;后者(`UNVERIFIED`)只登记不断言取值 ——
 * 把猜测钉进测试,就等于把猜测升级成了事实。
 *
 * 取证日期 2026-09-08,方法是逐个抓各厂商自己的文档页(能力矩阵 / 工具调用白名单 /
 * 接口 schema),不采信任何聚合站。
 */

interface Evidence {
  /** 依据本身。写「文档里看到了什么」,不写「我认为」 */
  readonly reason: string
  readonly source: string
  readonly ids: readonly string[]
}

/** 官方文档明确表明**不支持**工具调用的型号 */
const DOCUMENTED_NO_TOOLS: readonly Evidence[] = [
  {
    reason: '官方模型页的能力卡里没有 Function calling 一项 —— 同代其他型号的同一张卡都有',
    source: 'https://developers.openai.com/api/docs/models',
    ids: [
      'o1-mini',
      'o3-deep-research',
      'o4-mini-deep-research',
      'gpt-4o-search-preview',
      'gpt-4o-mini-search-preview',
      'gpt-realtime-translate'
    ]
  },
  {
    // ★ 这几行是「假阳性会真炸」的地方:sonar 长得像普通对话模型,发 tools 过去是硬错
    reason:
      '官方 OpenAPI 穷举了 Chat Completions 的全部入参,没有 tools/tool_choice;自定义工具只在另一套 Agent API 提供',
    source: 'https://docs.perplexity.ai/api-reference/sonar-post',
    ids: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro', 'sonar-deep-research']
  },
  {
    reason: 'TokenHub 能力矩阵里这几行没有 Function Calling —— 翻译与角色扮演专用模型',
    source: 'https://cloud.tencent.com/document/product/1823/130051',
    ids: [
      'hy-mt2-pro',
      'hy-mt2-plus',
      'hy-mt2-lite',
      'hy-mt2-30b-a3b',
      'hy-mt2-7b',
      'hy-mt2-1.8b',
      'hunyuan-role-latest',
      'hy-role'
    ]
  },
  {
    reason: '对话接口的 Tools.N 是排他白名单(仅 turbos / t1 / functioncall 生效),历次版本都不含这两行',
    source: 'https://cloud.tencent.com/document/product/1729/105701',
    ids: ['hunyuan-large', 'hunyuan-vision']
  },
  {
    reason: '方舟能力矩阵该行只有「文本生成 / 翻译增强」,不含「工具调用」',
    source: 'https://www.volcengine.com/docs/82379/1330310',
    ids: ['doubao-seed-translation-250915']
  },
  {
    // ★ 同一份文档、同一天,联网搜索白名单**列了** 4.5-turbo,函数调用白名单没列 ——
    // 两份名单的差集说明这是有意为之,不是漏写
    reason: 'Function calling「支持模型范围」逐个列 id,刻意不含 4.5-turbo / speed / lite 档',
    source: 'https://cloud.baidu.com/doc/qianfan-docs/s/xm95lyys5',
    ids: [
      'ernie-4.5-turbo-128k',
      'ernie-4.5-turbo-32k',
      'ernie-4.5-turbo-20260402',
      'ernie-4.5-turbo-vl',
      'ernie-4.5-turbo-vl-32k',
      'ernie-speed-128k',
      'ernie-lite-8k'
    ]
  },
  {
    reason: '模型页能力表逐版本标「Function Calling 不支持」,且不在 FC 文档的支持列表里',
    source: 'https://help.aliyun.com/zh/model-studio/qwen-function-calling',
    ids: ['qwen-long', 'qwen-math-plus']
  },
  {
    reason: 'FC 文档明写「暂不支持通义千问多模态模型」,现行多模态支持列表只到 Qwen3-VL',
    source: 'https://help.aliyun.com/zh/model-studio/qwen-function-calling',
    ids: ['qwen2.5-vl-72b-instruct', 'qwen2-vl-72b-instruct']
  },
  {
    reason: '模型页的「能力支持」卡片区独缺 Function Calling —— 同级的 GLM-4.6V 页则有',
    source: 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.5v',
    ids: ['glm-4.5v', 'glm-4v-plus', 'glm-ocr']
  },
  {
    reason: '工具调用页穷举了支持型号(推荐档 / Step Plan 档 / 其他兼容档),这几行都不在其中',
    source: 'https://platform.stepfun.com/docs/zh/api-reference/tool-call',
    ids: ['step-3', 'step-2-16k', 'step-1v-8k', 'step-1o-vision-32k']
  },
  {
    // ★ 同页的 response_format 白名单**含** Baichuan3-Turbo-128k,function 白名单不含 ——
    // 又一处「差集即证据」
    reason: '被有意排除在「支持 function 的模型列表」之外',
    source: 'https://platform.baichuan-ai.com/docs/api',
    ids: ['Baichuan3-Turbo-128k']
  },
  {
    reason: '医疗接口的请求参数表无 tools / tool_choice,role 枚举里也没有 tool',
    source: 'https://platform.baichuan-ai.com/docs/medical',
    ids: ['Baichuan-M3-Plus', 'Baichuan-M3', 'Baichuan-M2-Plus', 'Baichuan-M2']
  },
  {
    reason:
      '这些型号适配的是「图文对话生成」/「拟人对话生成」端点,其参数表没有 tools;函数调用是另一个端点的能力',
    source: 'https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs',
    ids: [
      'SenseNova-V6-5-Pro',
      'SenseNova-V6-5-Turbo',
      'SenseNova-V6-Pro',
      'SenseNova-V6-Turbo',
      'SenseNova-V6-Reasoner',
      'SenseChat-Vision',
      'SenseChat-Character-Pro',
      'SenseChat-Character'
    ]
  },
  {
    reason:
      '专属文档的参数表只有 model/messages/temperature/top_p/max_completion_tokens/stream,且不在定义了 tools 的两个 API 的 model enum 内',
    source: 'https://platform.minimax.io/docs/guides/text-chat',
    ids: ['MiniMax-M2-her']
  },
  {
    reason:
      'tools.function 注明「当前仅 Max、Ultra 版本支持」,而 generalv3 指向 Pro、pro-128k 指向 Pro-128K、lite 指向 Lite',
    source: 'https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html',
    ids: ['generalv3', 'pro-128k', 'spark-lite']
  },
  {
    reason: '官方 Command / Command Light 页全篇无 tool use;工具能力只归属 Command R 及更新型号',
    source: 'https://docs.cohere.com/docs/command-beta',
    ids: ['command-light']
  },
  {
    reason: '官方 model card 的输入格式只有 system/user/assistant,全文无 tool;Learn 上标注 Tool calling: No',
    source: 'https://huggingface.co/microsoft/phi-4',
    ids: ['phi-4']
  },
  {
    reason: '官方 chat_template 里没有任何 tool / function 分支',
    source: 'https://modelscope.cn/models/OpenGVLab/InternVL3_5-241B-A28B',
    ids: ['internvl3.5-241b-a28b', 'internvl3-38b']
  },
  {
    reason: '官方 chat_template 是纯 ChatML,无工具调用协议;该型号也已不在开放平台模型表内',
    source: 'https://modelscope.cn/models/01ai/Yi-1.5-34B-Chat',
    ids: ['yi-1.5-34b-chat']
  }
]

/**
 * 抓不到官方表述的型号 —— **登记,但不断言取值。**
 *
 * ★ 绝大多数是已下线或文档里查无此 id 的型号(零一万物整个 API 返回 410,
 * moonshot-v1 系列 2026-08-31 全平台下线,`MiniMax-01` / `abab6.5-chat` 在
 * MiniMax 官方文档里根本没出现过)。它们更该讨论的是「还要不要留在目录里」,
 * 而不是「tools 填什么」。
 */
const UNVERIFIED: readonly string[] = [
  'gemma-3-27b-it',
  'gemma-3-12b-it',
  'gemma-3-4b-it',
  'kimi-k2.5',
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
  'abab6.5-chat',
  'MiniMax-01',
  'hunyuan-muse',
  'hunyuan-muse-vision',
  'ernie-5.0-thinking-latest',
  'ernie-5.0-thinking-exp',
  'ernie-4.0-turbo',
  'ernie-vl-1.0',
  'step-1-flash',
  'Baichuan-Omni-1.5',
  'SenseChat',
  'SenseChat-Turbo',
  'SenseChat-5-Cantonese',
  'max-32k',
  'yi-large',
  'yi-large-turbo',
  'yi-vision'
]

const byId = new Map(BUILTIN_MODEL_CATALOG.map((m) => [m.id, m]))
const documentedNoTools = new Set(DOCUMENTED_NO_TOOLS.flatMap((e) => e.ids))

describe('能力表 · tools 证据', () => {
  it('两张表里的 id 都还在目录里', () => {
    // 型号被删掉而证据留着,下一个人会以为这条依据仍然管着某一行
    const missing = [...documentedNoTools, ...UNVERIFIED].filter((id) => !byId.has(id))
    expect(missing).toEqual([])
  })

  it('两张表不重叠', () => {
    expect(UNVERIFIED.filter((id) => documentedNoTools.has(id))).toEqual([])
  })

  it('有依据判定不支持的,目录里必须是 false', () => {
    const wrong = [...documentedNoTools].filter((id) => byId.get(id)?.capabilities.tools === true)
    expect(wrong).toEqual([])
  })

  it('每条依据都写了理由和来源', () => {
    for (const e of DOCUMENTED_NO_TOOLS) {
      expect(e.reason.length).toBeGreaterThan(10)
      expect(e.source).toMatch(/^https:\/\//)
      expect(e.ids.length).toBeGreaterThan(0)
    }
  })
})

describe('能力表 · tools 默认值', () => {
  /*
    ★★ **这条是本文件的主断言。**
    它钉的不是某一行的取值,而是「没被点名的文本模型一律支持工具」这条规则本身 ——
    也就是 `textCapabilities` 那个默认值。默认值一旦被改回 `false`,
    这里会有一百多个 id 同时失败,而不是让 Agent 在某台机器上悄悄变哑。
  */
  it('没被点名的文本模型一律 tools: true', () => {
    const exempt = new Set([...documentedNoTools, ...UNVERIFIED])
    const unexpected = BUILTIN_MODEL_CATALOG.filter(
      (m) => m.modality === 'text' && !exempt.has(m.id) && !m.capabilities.tools
    ).map((m) => m.id)
    expect(unexpected).toEqual([])
  })

  /** 各家主力各点一个 —— 这几个正是本次 bug 的现场 */
  it.each([
    'gpt-6-astra',
    'gpt-5.3-codex',
    'claude-opus-5',
    'claude-sonnet-5',
    'gemini-3.8-flash',
    'deepseek-v4-pro',
    'qwen3.8-max',
    'glm-5.3',
    'grok-4.6',
    'kimi-k3',
    'MiniMax-M3',
    'ernie-5.1'
  ])('%s 支持工具调用', (id) => {
    const model = byId.get(id)
    expect(model).toBeDefined()
    expect(model?.capabilities.tools).toBe(true)
    // 顺带钉住 `agent-session.ts` 真正用来做判断的那个函数,而不只是数据本身
    expect(modelSupportsTools({ capabilities: model!.capabilities })).toBe(true)
  })

  it('图像 / 视频 / 语音合成 / 转写模型不下发工具', () => {
    const media = BUILTIN_MODEL_CATALOG.filter(
      (m) => m.modality === 'image' || m.modality === 'video' || m.modality === 'transcription'
    )
    expect(media.length).toBeGreaterThan(10)
    expect(media.filter((m) => m.capabilities.tools).map((m) => m.id)).toEqual([])
  })
})
