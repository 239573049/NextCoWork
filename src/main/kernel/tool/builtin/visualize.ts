/**
 * `visualize_show_widget` / `visualize_read_me` —— 模型直接产出可视化内容的那条路。
 *
 * 需求:模型讲"复利是怎么滚起来的""这个 transformer 的结构"时,一行行文字是
 * 表达力最差的形式。这里给它一次**工具调用**,HTML/SVG 作为参数 payload 传进
 * 来,由渲染层在对话流里内联渲染出来 —— 不是图片,不是代码块,是一个真在跑的
 * HTML 应用(滑块能动、图表能画、脚本会执行)。
 *
 * 两个工具是**配套的一对**,不是两个独立功能:
 * - `visualize_read_me` 按需返回设计规范(7 万字,按模块切);
 * - `visualize_show_widget` 收代码。它的 description 里明确要求先读规范。
 *
 * ── 几条刻意的设计决定 ──
 *
 * 1. **没有 `i_have_seen_read_me` 这个参数。** Claude 早期实现里有它(一个
 *    "先读过文档"的布尔门闩),但泄漏出来的真实 schema 里只有下面这三个字段,
 *    Claude Code 报出来的原始调用记录也没有第四项。要求写在 description 里就够了 ——
 *    硬门闩的代价是模型偶尔会被自己的一个误写参数卡住整整一轮,而收益只是
 *    "它少漏读一次文档"。
 * 2. **`needsNetwork: true`,尽管这个工具自己一个字节都不出网。**
 *    它产出的是**会出网的东西**:widget 里 `<script src="https://cdn...">` 拉
 *    Chart.js 是这套规范推荐的常规做法(见 `visualize-guidelines/charts.ts`)。
 *    申报 false 的后果是用户关掉「联网」之后,仍然有一条从这里出网的路 ——
 *    正是 `permission-gate.ts` 里那句"别用 curl 绕过开关"要堵的同一件事。
 *    **代价要说清:开关关掉时连纯 SVG 图也做不了。** 这是刻意的取舍(宁可整个
 *    功能不可用,也不要一次静默出网)。若产品决定要放开,正确的做法是按
 *    `widget_code` 里有没有外链把它拆成两个工具,而不是把这个字段改回 false。
 * 3. **`readOnly: true`。** 它不碰工作区、不写盘、不改任何状态;产出物只挂在这条
 *    消息上。三档权限都直接放行,用户不会为每次画图点一次窗(network 那条闸
 *    排在只读之前,仍然管得住它)。
 * 4. **没有 `sendPrompt()`。** Claude 的 widget 里有一个"像用户打字一样往对话里
 *    发一条消息"的全局函数,规范正文里也常常让模型用它做下钻按钮。本宿主不给:
 *    它是 widget 通往 **agent 主循环**的一条输入通道 —— 点一下就开始一轮,
 *    而 widget 是模型生成的、还可能是它从某个网页里读来的内容。开不开放这条
 *    通道要单独定,现在先在 `read_me` 的 description 里明说"没有这个函数",
 *    免得模型照规范画出一批点了没反应的按钮。
 */
import { z } from 'zod'
import { MAX_TOOL_OUTPUT_CHARS } from '../../../../shared/agent/message'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { defineTool } from '../define'
import { AVAILABLE_MODULES, getGuidelines } from './visualize-guidelines'

/**
 * 返回给模型的那句话。
 *
 * ★ 最后一句是**必须的**,不是客套:模型天然倾向于把刚画出来的东西再用文字
 * 复述一遍(那是它训练里"解释清楚"的默认动作),而那样用户会在同一屏上看到
 * 同一份信息两遍 —— 一遍是图,一遍是图的文字版。Claude 的实现里也钉着这句。
 */
const RENDERED_NOTE =
  'Content rendered and shown to the user. Do not duplicate the shown content in text — it is already ' +
  'visually represented. Keep any remaining explanation in your normal reply text.'

/**
 * `widget_code` 的长度上限(字符)。128K 约等于一份很大的 SVG 图或一个带
 * 内联数据的仪表盘。
 *
 * ★ 上限存在的理由是**落盘**:这张卡跟着 `output.card` 进转录
 * (`repo.ts` 直接 `JSON.stringify(parts)`),没有上限的话一次失控的生成
 * 会往 SQLite 里写进去多少就得跟着读回来多少。超了就给模型一句明确的
 * 失败(它自己会知道要拆小),而不是静默截断一张画不出来的图。
 */
const MAX_WIDGET_CODE_CHARS = 128 * 1024

/**
 * 读取设计规范的工具。
 *
 * ★ 返回值**原样**是规范正文,不加任何我们自己的前后缀 —— 那段正文里
 * 满是"见上"/"见下"的交叉引用,插一句话进去就可能把一处引用指错。
 *
 * ★★ **这道长度检查是这个工具最容易被删掉的一段,它不是多余的。**
 * 工具结果在产出侧按 `MAX_TOOL_OUTPUT_CHARS`(64K 字符)截断
 * (`agent-session.ts` 调 `truncateToolOutput`),而规范正文按模块算:
 * `diagram` 单模块 ≈ 50K,可 `diagram + chart` 装配出来是 **70.5K** ——
 * 正好越过那条线。被截断的表现是最坏的一种:**规范从中间断掉,末尾补一句
 * "输出已截断"**,而模型不会觉得少了什么,它会照着前半截规范把图按错的
 * 规矩画出来,而且画得很有信心(复杂度预算、颜色规则、SVG 自检表都在后半截)。
 * 所以这里宁可**明确失败**:失败信息里带每个模块的体积,模型下一轮就会
 * 只挑一个。
 */
export const visualizeReadMeTool = defineTool({
  internalId: 'visualize_read_me',
  description:
    'Returns the required context for visualize_show_widget: CSS variables, color ramps, typography, layout ' +
    'rules, streaming-safe patterns and worked examples. Call it once before your first visualize_show_widget ' +
    'call, and again later if you need a different module. Do NOT mention or narrate this call to the user — ' +
    'it is an internal setup step. Call it silently and go straight to building the visualization. ' +
    /*
      ★ 这句必须留在 description 里,而且必须排在规范正文之前被读到 —— 那七万字
      里有一批例子用 `sendPrompt(...)` 做下钻按钮,而本宿主**没有实现它**
      (见文件头第 4 条)。不写这句,模型会照着规范画出一批点了没反应的按钮 ——
      那是"画出来的每个控件都是一次会失败的承诺",而它还会以为自己写对了。
    */
    'NOTE: this host does not provide sendPrompt() — ignore that function where the guidelines mention it, ' +
    'and do not build buttons that call it. Put the follow-up options in your reply text instead.',
  schema: z.object({
    modules: z
      .array(z.enum(AVAILABLE_MODULES))
      .min(1)
      .max(2)
      .describe(
        'Which module(s) to load. Pick every one that fits the visual you are about to build. At most two — ' +
          'the largest combination (diagram + chart) does not fit in one response.'
      )
  }),
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(input) {
    const text = getGuidelines(input.modules)
    if (text.length > MAX_TOOL_OUTPUT_CHARS) {
      const sizes = input.modules.map((m) => `${m}: ${String(getGuidelines([m]).length)} chars`).join(', ')
      return toolFail(
        `These modules together are ${String(text.length)} characters and the result is capped at ` +
          `${String(MAX_TOOL_OUTPUT_CHARS)}, so returning them would cut the guidelines off mid-rule. ` +
          `Call again with a single module. Sizes requested: ${sizes}.`
      )
    }
    return toolOk(text)
  }
})

/**
 * 收代码、产出 widget 卡片的工具。
 */
export const visualizeShowWidgetTool = defineTool({
  internalId: 'visualize_show_widget',
  description:
    'Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — that renders inline ' +
    'in the conversation. Use for flowcharts, architecture diagrams, dashboards, forms, calculators, data ' +
    'tables, and illustrations. The code is auto-detected: starting with <svg means SVG mode, anything else is ' +
    'HTML mode. IMPORTANT: call visualize_read_me before your first call, and never narrate that call — call ' +
    'it silently and then respond as if you went straight to building the visualization.',
  schema: z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'Use a short snake_case identifier, e.g. q4_revenue_by_product_line.')
      .describe(
        'Short snake_case identifier for this visual. Must disambiguate — if the conversation has several ' +
          'visuals, this title alone should say which one is meant (q4_revenue_by_product_line, not chart).'
      ),
    widget_code: z
      .string()
      .min(1)
      .max(MAX_WIDGET_CODE_CHARS)
      .describe(
        'The SVG or HTML to render. SVG mode: raw SVG starting with <svg>. HTML mode: a fragment — no ' +
          '<!DOCTYPE>, <html>, <head> or <body>. Use the CSS variables from visualize_read_me for every ' +
          'color, keep the background transparent and avoid top-level padding. Put <script> last: scripts run ' +
          'after streaming finishes.'
      ),
    loading_messages: z
      .array(z.string().trim().min(1).max(120))
      .min(1)
      .max(4)
      .describe(
        '1–4 short messages shown while the visual streams in, each roughly 5 words, in the language the user ' +
          'is writing. For serious topics (illness, death, war, disaster, trauma) keep them deliberately flat ' +
          'and procedural — no evocative wording.'
      )
  }),
  readOnly: true,
  destructive: false,
  // 见文件头第 2 条:它自己不出网,但它产出的东西会。
  needsNetwork: true,
  async run(input) {
    /*
      `content` 是模型唯一看得见的东西;`card` 只走 UI 轨,编码器一律 strip
      (`shared/agent/tool-card.ts` 的文件头写着这条)。所以这里不把 H 代码回灌给模型 ——
      它自己刚写完,回灌既浪费窗口又会让它想再改一遍。
    */
    return toolOk(RENDERED_NOTE, {
      card: { kind: 'widget', title: input.title, code: input.widget_code }
    })
  }
})
