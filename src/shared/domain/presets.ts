/**
 * 内置供应商预设 —— 方案 §8。**纯数据 + 类型,没有任何逻辑。**
 *
 * 数据来自子代理实测采集(报告:`~/.claude/plans/distributed-jingling-snowglobe-agent-a47e66b04e7079eb0.md`),
 * 判据是 **`curl` 探针 + 同前缀假路径对照** —— 只有「真路径 401 + 假路径 404」才算数。
 * 这道对照不是讲究:DeepSeek / 火山 / 讯飞星火 / 智谱 `/api/paas/v4` 这几家对**任意**路径
 * 都返回 401,不做对照拿到的全是假阳性。
 *
 * ★ **这张表是会腐烂的**,而且腐烂得比代码快 —— 调研当场就实测到老别名
 * `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 下线。所以:
 * `suggestedModels` 只是**冷启动兜底**,真正的模型列表靠运行时 `GET {base}/models` 拉。
 */
import type { UpstreamProtocol } from './provider'

/**
 * ★★ **baseUrl 挂在 endpoint 上,不挂在预设上。** 这是本文件的核心结构,
 * 也是调研推翻我第一版设计的地方。
 *
 * §1.1 把「API 格式」做成了用户随手能翻的开关,可**同一家厂商两个协议的路径前缀
 * 往往不同**(实测,不是个别现象):
 *
 * | 厂商 | OpenAI base | Anthropic base |
 * |---|---|---|
 * | DeepInfra | `…/v1/openai` | `…/anthropic` |
 * | OpenRouter | `…/api/v1` | `…/api` |
 * | Fireworks | `…/inference/v1` | `…/inference` |
 * | 智谱 | `…/api/paas/v4` | `…/api/anthropic` |
 * | 火山方舟 | `…/api/v3` | `…/api/compatible` |
 * | 硅基流动 / Together / 阶跃星辰 | `…/v1` | 裸域名 |
 *
 * 扁平结构下,用户翻一下那个开关地址就**静默失效** —— 表单看着完全正常,请求 404。
 */
export interface ProviderEndpoint {
  protocol: UpstreamProtocol
  /**
   * 规范形式:**不带尾斜杠**(Gemini 兼容层是唯一例外,见 `baseurl.ts`)。
   *
   * ★ OpenAI 族的**版本段是这里的一部分**(`/v1`、`/api/paas/v4`、`/inference/v1` …),
   * Anthropic 族则**不带** `/v1`(客户端自己补 `/v1/messages`)。
   * 两族约定是反的,理由和证据见 `baseurl.ts` 的 `REQUEST_PATH`。
   */
  baseUrl: string
  /**
   * 能否 `GET {baseUrl}/models`。false 时置灰「从服务商拉取模型列表」按钮,
   * 而不是让用户点了再报错。
   *
   * ★ **只在拿到证据时才 true。** 「没证据」和「确认没有」都记 false ——
   * 因为这个字段唯一的消费者是一个按钮的可点性,而一个点下去必然失败的按钮
   * 比一个灰着的按钮更糟。智谱 / Z.AI / 火山这几家的探针被 catch-all 401 废掉了,
   * 所以它们是 false,不代表上游真的没有。
   *
   * ★ 拉列表的 URL 是 **`{baseUrl}/models`**,不要拿 `joinUpstreamUrl` 去拼 ——
   * 那个函数是给**请求路径**用的,带着 Anthropic 的 `/v1` 去重逻辑。
   * OpenAI 族的 base 自带版本段,直接接 `/models` 就对;Anthropic 族是
   * `{baseUrl}/v1/models`。
   */
  supportsModelList: boolean
  /** 免鉴权就能拉列表(OpenRouter / DeepInfra / OpenCode Go 实测 200)—— 可以做到「key 还没填就先看有哪些模型」 */
  modelListPublic?: boolean
}

/**
 * ★ 参考图的第一个 Tab 是「推荐服务」,但调研报告写得很清楚:
 * **它是从其余四类里挑出来的精选,不是第五个独立类别。**
 *
 * 所以这里是**四个值 + 一个布尔**,而不是方案 §8 写的五值联合 ——
 * 五值联合下 OpenAI 会因为「进了推荐」而从「海外平台」里消失,
 * 用户翻海外平台那一栏找不到 OpenAI。这是照方案原样写会得到的界面 bug,
 * 所以这里**故意偏离方案**,偏离的理由写在这。
 */
export type PresetCategory = 'domestic' | 'aggregator' | 'overseas' | 'local'

export interface ProviderPreset {
  id: string
  name: string
  category: PresetCategory
  /** 第一个 Tab「推荐服务」= 这个标记为真的那些,按本表顺序 */
  recommended?: boolean
  /** 至少一条。翻「API 格式」开关时按 protocol 在这里查地址 */
  endpoints: readonly ProviderEndpoint[]
  docsUrl: string
  suggestedModels: readonly string[]
  /** 订阅制额度(Coding Plan 之类)—— 这类不计入总费用,见方案 §5.3 */
  subscription?: boolean
  /** 该预设特有的坑,直接显示在表单下方 */
  notes?: string
  /**
   * 本条数据的核实等级,**取该预设最弱的一条 endpoint**。
   *
   * - `probed` —— 探针确认(真路径 401 + 同前缀假路径 404)
   * - `documented` —— 官方文档/官方站点提取,未能实测
   * - `unverified` —— 证据不足,卡片上带角标
   *
   * 让「未核实」进代码而不是停在报告里:用户配失败时知道该去查文档,
   * 而不是怀疑自己填错了。
   */
  verification: 'probed' | 'documented' | 'unverified'
}

/** 本地运行时一律 `127.0.0.1`,理由见文件末尾的 `LOCAL_NOTE` */
const oa = (
  baseUrl: string,
  supportsModelList: boolean,
  modelListPublic?: boolean
): ProviderEndpoint => ({
  protocol: 'openai-chat',
  baseUrl,
  supportsModelList,
  ...(modelListPublic === undefined ? {} : { modelListPublic })
})

const resp = (baseUrl: string, supportsModelList: boolean): ProviderEndpoint => ({
  protocol: 'openai-responses',
  baseUrl,
  supportsModelList
})

const anth = (baseUrl: string, supportsModelList = false): ProviderEndpoint => ({
  protocol: 'anthropic',
  baseUrl,
  supportsModelList
})

/**
 * ★ 本地地址**一律写 `127.0.0.1` 而不是 `localhost`**。
 *
 * Node 17+ 起不再重排 DNS 结果,部分系统会把 `localhost` 优先解析到 IPv6 `::1`,
 * 而这些运行时默认只监听 IPv4 —— 表现是「浏览器里能打开、应用里 ECONNREFUSED」。
 * 这是本地模型接入最高频的一类假故障(同类问题见 microsoft/vscode#189805),
 * 预设里直接写死,不给用户踩坑的机会。
 */
const LOCAL_NOTE = '无需真实密钥,随便填一个占位串即可。'

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // ────────────────────────── 海外平台 ──────────────────────────
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'overseas',
    recommended: true,
    endpoints: [oa('https://api.openai.com/v1', true), resp('https://api.openai.com/v1', true)],
    docsUrl: 'https://developers.openai.com/api/docs',
    suggestedModels: ['gpt-5.6-luna-pro', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5-pro'],
    verification: 'documented'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'overseas',
    recommended: true,
    endpoints: [anth('https://api.anthropic.com', true)],
    docsUrl: 'https://platform.claude.com/docs/en/api/overview',
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5.1', 'claude-opus-4.8'],
    verification: 'documented'
  },
  {
    id: 'gemini-openai',
    name: 'Google Gemini(OpenAI 兼容)',
    category: 'overseas',
    recommended: true,
    /*
      ★ 尾斜杠是**故意留着**的:官方 Python 示例就是这个形状,`baseurl.ts` 为它开了例外。
      兼容层的端点是 `/v1beta/openai/chat/completions` —— 版本段在 base 里,
      所以这一条和 DeepInfra、智谱那几家是同一类,不是特例。
    */
    endpoints: [oa('https://generativelanguage.googleapis.com/v1beta/openai/', true)],
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    suggestedModels: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.1-pro'],
    notes:
      '兼容层不支持 Responses API。★ 流式响应的**每个 chunk 都带 usage**(官方 Current limitations),' +
      '朴素累加会让 token 数虚高数倍 —— 取最后一个,不要相加。',
    verification: 'documented'
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    category: 'overseas',
    endpoints: [resp('https://api.x.ai/v1', true), oa('https://api.x.ai/v1', true)],
    docsUrl: 'https://docs.x.ai/overview',
    suggestedModels: ['grok-4.6', 'grok-4.5', 'grok-4.20'],
    notes: 'Responses API 是官方主推端点,chat/completions 已被归入 legacy/。',
    verification: 'documented'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    category: 'overseas',
    endpoints: [oa('https://api.mistral.ai/v1', true)],
    docsUrl: 'https://docs.mistral.ai/api',
    suggestedModels: ['mistral-medium-3-5', 'mistral-large-2512', 'devstral-2512'],
    verification: 'documented'
  },
  {
    id: 'cohere',
    name: 'Cohere(OpenAI 兼容)',
    category: 'overseas',
    endpoints: [oa('https://api.cohere.ai/compatibility/v1', false)],
    docsUrl: 'https://docs.cohere.com/docs/compatibility-api',
    suggestedModels: ['command-a-plus-05-2026', 'command-a-03-2025'],
    notes:
      '★ 三个 URL 三种组合:兼容层在 api.cohere.ai/compatibility/v1,原生 chat 在 ' +
      'api.cohere.com/v2/chat,而模型列表在 api.cohere.com/v1/models(v1,且是另一个域名)—— ' +
      '所以「拉取模型列表」在这里用不了。兼容层的 reasoning_effort 只接受 none 与 high。',
    verification: 'documented'
  },

  // ────────────────────────── 国内服务 ──────────────────────────
  {
    id: 'deepseek',
    name: 'DeepSeek 深度求索',
    category: 'domestic',
    recommended: true,
    /*
      ★ 标 documented 而不是 probed,**尽管报告里这一条打了 ✅**:
      DeepSeek 的网关对**任意**路径都返回 401(报告 §0 点名的四家之一),
      所以「401 = 路径存在」在这里不成立,那个 ✅ 是假阳性。地址本身来自官方文档。
    */
    endpoints: [
      oa('https://api.deepseek.com/v1', true),
      anth('https://api.deepseek.com/anthropic')
    ],
    docsUrl: 'https://api-docs.deepseek.com/',
    suggestedModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    notes:
      '★ 老别名 deepseek-chat / deepseek-reasoner 已于 2026-07-24 下线,填了会直接 400。' +
      '官方注明地址里的 v1 与模型版本无关,带不带都通。',
    verification: 'documented'
  },
  {
    id: 'moonshot',
    name: 'Moonshot·按量 API(国内)',
    category: 'domestic',
    endpoints: [
      oa('https://api.moonshot.cn/v1', true),
      resp('https://api.moonshot.cn/v1', true),
      anth('https://api.moonshot.cn/anthropic')
    ],
    docsUrl: 'https://platform.kimi.ai/docs/guide/claude-code-kimi',
    suggestedModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    notes: '★ 按量 key 与 Coding Plan 订阅 key 不通用,地址也不是同一个(见「Kimi·Coding Plan」)。',
    verification: 'probed'
  },
  {
    id: 'moonshot-global',
    name: 'Moonshot·按量 API(国际)',
    category: 'domestic',
    endpoints: [
      oa('https://api.moonshot.ai/v1', true),
      resp('https://api.moonshot.ai/v1', true),
      anth('https://api.moonshot.ai/anthropic')
    ],
    docsUrl: 'https://platform.kimi.ai/docs/guide/claude-code-kimi',
    suggestedModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    verification: 'probed'
  },
  {
    id: 'kimi-coding',
    name: 'Kimi·Coding Plan(订阅制)',
    category: 'domestic',
    recommended: true,
    subscription: true,
    /*
      ★ 同一个服务两个协议,前缀差一段 `/v1` —— OpenAI 族的版本段在 base 里,
      Anthropic 族的不在。实测存在的是 `/coding/v1/messages` 与 `/coding/v1/chat/completions`。
    */
    endpoints: [anth('https://api.kimi.com/coding'), oa('https://api.kimi.com/coding/v1', true)],
    docsUrl: 'https://www.kimi.com/coding/docs/en/',
    suggestedModels: ['kimi-k3', 'kimi-k2.7-code'],
    notes:
      '★ 域名是 api.kimi.com,**不是** api.moonshot.cn —— 社区里大量「Coding Plan 配 ' +
      'api.moonshot.cn/anthropic 报 401」都出在这里。api.kimi.com 上只有 /coding 前缀可用。',
    verification: 'probed'
  },
  {
    id: 'zhipu',
    name: '智谱·按量 API(国内)',
    category: 'domestic',
    endpoints: [oa('https://open.bigmodel.cn/api/paas/v4', false)],
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/claude',
    suggestedModels: ['glm-5.3', 'glm-5.2', 'glm-4.7'],
    notes: '★ 按量 key 打不到 Coding Plan 的地址,反之亦然 —— 两套独立的鉴权域。',
    verification: 'probed'
  },
  {
    id: 'zhipu-coding',
    name: '智谱·GLM Coding Plan(订阅制)',
    category: 'domestic',
    recommended: true,
    subscription: true,
    endpoints: [
      anth('https://open.bigmodel.cn/api/anthropic'),
      oa('https://open.bigmodel.cn/api/coding/paas/v4', false)
    ],
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
    suggestedModels: ['glm-5.3', 'glm-5.2'],
    notes: '★ 订阅 key 与按量 key 不通用。这是「配了半天 401」的头号原因。',
    verification: 'probed'
  },
  {
    id: 'zai',
    name: 'Z.AI(智谱国际)按量',
    category: 'domestic',
    endpoints: [oa('https://api.z.ai/api/paas/v4', false)],
    docsUrl: 'https://docs.z.ai/devpack/quick-start',
    suggestedModels: ['glm-5.3', 'glm-5.2'],
    verification: 'probed'
  },
  {
    id: 'zai-coding',
    name: 'Z.AI Coding Plan(订阅制)',
    category: 'domestic',
    subscription: true,
    endpoints: [
      anth('https://api.z.ai/api/anthropic'),
      oa('https://api.z.ai/api/coding/paas/v4', false)
    ],
    docsUrl: 'https://docs.z.ai/devpack/quick-start',
    suggestedModels: ['glm-5.3', 'glm-5.2'],
    notes: '★ 订阅 key 与按量 key 不通用。',
    verification: 'probed'
  },
  {
    id: 'minimax',
    name: 'MiniMax(国内)',
    category: 'domestic',
    endpoints: [
      oa('https://api.minimaxi.com/v1', true),
      resp('https://api.minimaxi.com/v1', true),
      anth('https://api.minimaxi.com/anthropic')
    ],
    docsUrl: 'https://platform.minimax.io/docs/token-plan/claude-code',
    suggestedModels: ['minimax-m3', 'minimax-m2.7'],
    notes: '★ 国内是 minimaxi.com(多一个 i),国际是 minimax.io —— 两个域名都真实存在。',
    verification: 'probed'
  },
  {
    id: 'minimax-global',
    name: 'MiniMax(国际)',
    category: 'domestic',
    endpoints: [oa('https://api.minimax.io/v1', true), anth('https://api.minimax.io/anthropic')],
    docsUrl: 'https://platform.minimax.io/docs/token-plan/claude-code',
    suggestedModels: ['minimax-m3', 'minimax-m2.7'],
    verification: 'probed'
  },
  {
    id: 'dashscope',
    name: '阿里百炼 / 通义(国内)',
    category: 'domestic',
    endpoints: [
      oa('https://dashscope.aliyuncs.com/compatible-mode/v1', true),
      resp('https://dashscope.aliyuncs.com/compatible-mode/v1', true)
    ],
    docsUrl: 'https://help.aliyun.com/zh/model-studio/claude-code',
    suggestedModels: ['qwen3.8-max', 'qwen3.8-flash', 'qwen-plus'],
    notes:
      '★ Anthropic 兼容层没有做进预设:它的地址里带 WorkspaceId 与 region,每个账号都不同,' +
      '填不出一个通用值 —— 需要的话照官方文档手填。另:那一层**只有 /v1/messages,没有 /v1/models**。',
    verification: 'probed'
  },
  {
    id: 'dashscope-intl',
    name: '阿里百炼(国际)',
    category: 'domestic',
    endpoints: [oa('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', true)],
    docsUrl: 'https://help.aliyun.com/zh/model-studio/claude-code',
    suggestedModels: ['qwen3.8-max', 'qwen3.8-flash'],
    verification: 'probed'
  },
  {
    id: 'volcengine',
    name: '火山方舟·豆包',
    category: 'domestic',
    endpoints: [
      oa('https://ark.cn-beijing.volces.com/api/v3', false),
      anth('https://ark.cn-beijing.volces.com/api/compatible')
    ],
    docsUrl: 'https://www.volcengine.com/docs/82379',
    /* 报告没能核实到可用的模型 ID(火山用的是接入点 ID),宁可空着也不编 */
    suggestedModels: [],
    notes: '★ 火山用「接入点 ID」而不是模型名,需要先在控制台创建接入点,再把它的 ID 填成模型。',
    verification: 'documented'
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    category: 'domestic',
    endpoints: [oa('https://qianfan.baidubce.com/v2', false)],
    docsUrl: 'https://qianfan.baidubce.com',
    suggestedModels: [],
    notes: '★ 千帆走 IAM AK/SK 鉴权,不一定吃 Bearer —— 配不通时先对一遍官方文档的鉴权方式。',
    verification: 'probed'
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    category: 'domestic',
    endpoints: [oa('https://api.hunyuan.cloud.tencent.com/v1', true)],
    docsUrl: 'https://cloud.tencent.com/document/product/1729',
    suggestedModels: [],
    notes: '实测**不提供** Anthropic 兼容端点。',
    verification: 'probed'
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    category: 'domestic',
    endpoints: [
      oa('https://api.stepfun.com/v1', true),
      resp('https://api.stepfun.com/v1', true),
      anth('https://api.stepfun.com')
    ],
    docsUrl: 'https://platform.stepfun.com/docs',
    suggestedModels: [],
    verification: 'probed'
  },
  {
    id: 'baichuan',
    name: '百川智能',
    category: 'domestic',
    endpoints: [oa('https://api.baichuan-ai.com/v1', true)],
    docsUrl: 'https://platform.baichuan-ai.com/docs/api',
    suggestedModels: [],
    verification: 'probed'
  },
  {
    id: 'sensenova',
    name: '商汤日日新 SenseNova',
    category: 'domestic',
    endpoints: [oa('https://api.sensenova.cn/compatible-mode/v1', false)],
    docsUrl: 'https://console.sensecore.cn/help/docs/model-as-a-service/nova',
    suggestedModels: [],
    notes: '实测没有 /models 接口,「拉取模型列表」用不了,模型 ID 需要手填。',
    verification: 'probed'
  },
  {
    id: 'spark',
    name: '讯飞星火',
    category: 'domestic',
    endpoints: [oa('https://spark-api-open.xf-yun.com/v1', false)],
    docsUrl: 'https://www.xfyun.cn/doc/spark/Web.html',
    suggestedModels: [],
    notes: '★ 地址未能实测核实(该网关对任意路径都 401),配不通时以官方文档为准。',
    verification: 'unverified'
  },

  // ────────────────────────── 聚合平台 ──────────────────────────
  {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'aggregator',
    recommended: true,
    endpoints: [
      oa('https://openrouter.ai/api/v1', true, true),
      resp('https://openrouter.ai/api/v1', true),
      anth('https://openrouter.ai/api')
    ],
    docsUrl: 'https://openrouter.ai/docs/api_reference/overview',
    suggestedModels: ['anthropic/claude-fable-5.1', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    notes: '模型 ID 带 vendor/ 前缀。模型列表免鉴权就能拉 —— 没填 key 也能先看有哪些模型。',
    verification: 'probed'
  },
  {
    id: 'siliconflow',
    name: '硅基流动(国内)',
    category: 'aggregator',
    recommended: true,
    endpoints: [oa('https://api.siliconflow.cn/v1', true), anth('https://api.siliconflow.cn')],
    docsUrl: 'https://docs.siliconflow.cn/cn/userguide/quickstart',
    suggestedModels: ['deepseek-ai/DeepSeek-V3.2', 'zai-org/GLM-5.2'],
    notes: '模型 ID 是 HuggingFace 的 Org/Name 形式,**大小写敏感**。不支持 Responses API。',
    verification: 'probed'
  },
  {
    id: 'siliconflow-intl',
    name: '硅基流动(国际)',
    category: 'aggregator',
    endpoints: [oa('https://api.siliconflow.com/v1', true), anth('https://api.siliconflow.com')],
    docsUrl: 'https://docs.siliconflow.com/en/userguide/quickstart',
    suggestedModels: ['deepseek-ai/DeepSeek-V3.2', 'zai-org/GLM-5.2'],
    notes: '★ 国内站(.cn)与国际站(.com)的账号是否互通未核实,建议按两个供应商分别配 key。',
    verification: 'probed'
  },
  {
    id: 'together',
    name: 'Together AI',
    category: 'aggregator',
    endpoints: [
      oa('https://api.together.xyz/v1', true),
      resp('https://api.together.xyz/v1', true),
      anth('https://api.together.xyz')
    ],
    docsUrl: 'https://docs.together.ai/docs/quickstart',
    suggestedModels: [],
    verification: 'documented'
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    category: 'aggregator',
    endpoints: [
      oa('https://api.fireworks.ai/inference/v1', true),
      resp('https://api.fireworks.ai/inference/v1', true),
      anth('https://api.fireworks.ai/inference')
    ],
    docsUrl: 'https://docs.fireworks.ai/tools-sdks/anthropic-compatibility',
    suggestedModels: ['accounts/fireworks/models/deepseek-v3p2'],
    notes:
      '模型 ID 形如 accounts/fireworks/models/<name>,且**点号写作 p**(v3.2 → v3p2)。' +
      'Anthropic 地址官方明写不带 /v1。',
    verification: 'probed'
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    category: 'aggregator',
    endpoints: [
      oa('https://api.deepinfra.com/v1/openai', true, true),
      anth('https://api.deepinfra.com/anthropic')
    ],
    docsUrl: 'https://docs.deepinfra.com/api-reference/introduction',
    suggestedModels: ['deepseek-ai/DeepSeek-V3.2'],
    notes:
      '★ **最容易配错的一家**:OpenAI 前缀是 /v1/openai,Anthropic 前缀是 /anthropic —— ' +
      '完全不同。/v1/openai/messages、/v1/messages、/v1/anthropic/messages 三种直觉写法全部 404(实测)。' +
      '不支持 Responses API。',
    verification: 'probed'
  },
  {
    id: 'groq',
    name: 'Groq',
    category: 'aggregator',
    endpoints: [
      oa('https://api.groq.com/openai/v1', true),
      resp('https://api.groq.com/openai/v1', true)
    ],
    docsUrl: 'https://console.groq.com/docs/openai',
    suggestedModels: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    notes:
      '没有官方 Anthropic 端点。Responses API 是**子集**:previous_response_id / store / ' +
      'truncation / include 都不支持。模型 ID 风格混合 —— Llama 系裸名,其余带命名空间。',
    verification: 'documented'
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go(订阅制)',
    category: 'aggregator',
    subscription: true,
    /*
      ★ 三个协议**同一个 base**,这是全表唯一一处 Anthropic base 带 `/v1` 的例外 ——
      这里的 `/v1` 是路由前缀,不是 Anthropic 的版本段。`joinUpstreamUrl` 的去重分支
      正好把它拼成实测存在的那个 `POST /zen/go/v1/messages`,不会变成 `/v1/v1/`。
      (这也是那个分支今天唯一还在服务的真实场景之一。)
    */
    endpoints: [
      oa('https://opencode.ai/zen/go/v1', true, true),
      resp('https://opencode.ai/zen/go/v1', true),
      anth('https://opencode.ai/zen/go/v1')
    ],
    docsUrl: 'https://opencode.ai/docs/go/',
    suggestedModels: ['minimax-m3', 'kimi-k3', 'glm-5.3', 'deepseek-v4-pro', 'grok-4.6'],
    notes:
      '★ **协议是跟着模型走的,不是你选的**:GLM/Kimi/DeepSeek 走 chat/completions,' +
      'MiniMax/Qwen 走 messages,Grok/GPT 走 responses —— 选错会 400。' +
      '额度按美元计($10/月),不按 token。模型列表免鉴权就能拉。',
    verification: 'probed'
  },
  {
    id: 'aihubmix',
    name: 'AiHubMix',
    category: 'aggregator',
    endpoints: [oa('https://aihubmix.com/v1', false), anth('https://aihubmix.com')],
    docsUrl: 'https://docs.aihubmix.com/en/quick-start',
    suggestedModels: [],
    notes:
      '★ 地址未能核实(采集环境不可达),以官方文档为准。中转站透传上游原名,模型 ID 不加命名空间。',
    verification: 'unverified'
  },
  {
    id: '302ai',
    name: '302.AI',
    category: 'aggregator',
    endpoints: [oa('https://api.302.ai/v1', false), anth('https://api.302.ai')],
    docsUrl: 'https://doc.302.ai/365145292e0',
    suggestedModels: [],
    notes: '★ 地址未能核实(采集环境不可达),以官方文档为准。',
    verification: 'unverified'
  },
  {
    id: 'ohmygpt',
    name: 'OhMyGPT',
    category: 'aggregator',
    endpoints: [oa('https://api.ohmygpt.com/v1', false)],
    docsUrl: 'https://docs.ohmygpt.com/docs/api',
    suggestedModels: [],
    notes: '★ 地址未能核实(采集环境不可达),以官方文档为准。',
    verification: 'unverified'
  },

  // ────────────────────────── 本地模型 ──────────────────────────
  {
    id: 'ollama',
    name: 'Ollama',
    category: 'local',
    recommended: true,
    endpoints: [oa('http://127.0.0.1:11434/v1', true), anth('http://127.0.0.1:11434')],
    docsUrl: 'https://docs.ollama.com/openai',
    suggestedModels: [],
    notes: `${LOCAL_NOTE}默认只绑 127.0.0.1:11434,跨源访问需要设 OLLAMA_ORIGINS。`,
    verification: 'documented'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    category: 'local',
    endpoints: [
      oa('http://127.0.0.1:1234/v1', true),
      resp('http://127.0.0.1:1234/v1', true),
      anth('http://127.0.0.1:1234')
    ],
    docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    suggestedModels: [],
    notes: `${LOCAL_NOTE}三种协议齐全,是本地里唯一确认支持 Responses API 的。`,
    verification: 'documented'
  },
  {
    id: 'vllm',
    name: 'vLLM',
    category: 'local',
    endpoints: [oa('http://127.0.0.1:8000/v1', true), anth('http://127.0.0.1:8000')],
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    suggestedModels: [],
    notes:
      '★ --api-key 只保护 /v1、/v2、/inference 前缀,不保护 /invocations。' +
      '另:Anthropic 适配器只有 Python frontend 有,Rust frontend 还没实现。',
    verification: 'documented'
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    category: 'local',
    endpoints: [oa('http://127.0.0.1:8080/v1', true), anth('http://127.0.0.1:8080')],
    docsUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
    suggestedModels: [],
    notes:
      `${LOCAL_NOTE}★ 工具调用**必须加 --jinja**,否则 tool_calls 静默不生效 —— ` +
      '这是「模型明明支持工具却不调用」的头号原因。默认端口 8080 与 LocalAI 撞车。',
    verification: 'documented'
  },
  {
    id: 'localai',
    name: 'LocalAI',
    category: 'local',
    endpoints: [oa('http://127.0.0.1:8080/v1', true), anth('http://127.0.0.1:8080')],
    docsUrl: 'https://localai.io/features/openai-functions/',
    suggestedModels: [],
    notes: `${LOCAL_NOTE}★ 默认端口 8080 与 llama.cpp server 撞车,两个一起跑时记得改一个。`,
    verification: 'documented'
  },
  {
    id: 'jan',
    name: 'Jan',
    category: 'local',
    endpoints: [oa('http://127.0.0.1:1337/v1', true)],
    docsUrl: 'https://jan.ai/docs/api-server',
    suggestedModels: [],
    notes: `${LOCAL_NOTE}Anthropic 端点未核实,没有做进预设。`,
    verification: 'documented'
  }
]

/** 按分类取,保持表内顺序 */
export function presetsByCategory(category: PresetCategory): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((p) => p.category === category)
}

/** 第一个 Tab。见 `PresetCategory` 上面那段:推荐是跨类别的精选,不是第五个类别 */
export function recommendedPresets(): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((p) => p.recommended === true)
}

export function findPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? null
}

/**
 * 用户在表单里翻「API 格式」开关时用它换地址。
 *
 * ★ 找不到返回 null,**不要退回第一条** —— 退回去就是「界面显示 Anthropic、
 * 地址却是 OpenAI 那条」,正是这套结构要防的静默失效。
 */
export function endpointFor(
  p: ProviderPreset,
  protocol: UpstreamProtocol
): ProviderEndpoint | null {
  return p.endpoints.find((e) => e.protocol === protocol) ?? null
}
