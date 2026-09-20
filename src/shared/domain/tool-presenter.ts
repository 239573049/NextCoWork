/**
 * 工具 → 展示契约的注册表 —— 设计文档 `docs/tool-timeline-design.md` §1。
 *
 * ★ **为什么是注册表而不是 `switch (name)`。**
 * MCP 工具在编译期不可枚举,`switch` 必然带一个 `default`;而 `default` 一旦存在,
 * 新增内置工具时忘记加分支**不会有任何编译错误** —— 它会静默落进兜底,
 * 表现为「新工具长得和 MCP 工具一模一样」,而没有人会去查一个不报错的地方。
 * 写成数据之后,`index.test.ts` 里一条 `builtinTools().every(t => t.internalId in REGISTRY)`
 * 就能让遗漏在测试期炸出来。
 *
 * ★ **这里的函数全是纯函数,入参只有 `(input, output)`,不许碰任何 store。**
 * 这是它们能被单测穷尽的前提,也是它们能同时服务于「已提交的 parts」和
 * 「还在流的 live 块」两条路径的前提。
 *
 * ★ **`input` 是 `unknown`,而且经常不是完整对象。** 流式中的 `tool_call_delta`
 * 会先被工具卡片投影成「目前可读出的部分对象」；畸形前缀仍会退回原始字符串。
 * 所有 `pick` 因此都必须安全收窄 —— 字段没到时标题要退化成可读短语,不能崩溃或显示 "undefined"。
 *
 * ★ **查表的键是 `externalName`**(转录里存的那个),不是 `internalId`。
 * 内置工具两者一致,MCP 超长名的差异由 `parseMcpId` 吸收 —— 详见那里的说明。
 */
import type { ToolOutput } from '../agent/message'

/**
 * 展示形态。判据是**「展开后详情区该用哪种渲染器」**,不是工具的功能领域。
 *
 * 功能相近但形态不同的必须分开:`Read` 与 `Write` 都是 fs,但一个是只读预览、
 * 一个是写入摘要。功能不同但形态相同的可以合并:`Glob` 与 `Grep` 都是命中列表。
 *
 * 刻意**不复用** `ToolInfo.readOnly` / `destructive`(`tool.ts`)来分类 ——
 * 那两个是**权限维度**,与展示维度正交:`Read` 和 `Grep` 都是 readOnly,
 * 详情长相却完全不同。
 */
export type ToolShape =
  | 'reasoning'
  | 'read'
  | 'mutate'
  | 'search'
  | 'command'
  | 'network'
  | 'orchestration'
  | 'external'

export interface ToolPresenter {
  shape: ToolShape
  /** 折叠态主标题。★ 拿不到入参时**必须仍返回一个可读串**,不能返回空。 */
  title: (input: unknown) => string
  /** 折叠态右侧摘要。信息不足时返回 `undefined`,调用方据此不渲染那一格。 */
  summary?: (input: unknown, output: ToolOutput | undefined) => string | undefined
  /**
   * 运行中能不能被用户**单独**停掉(`shell:stopToolCall`)。
   *
   * ★ 这是一条**能力声明,不是偏好**:主进程只为 `Bash` 寄存停止句柄
   * (见 `main/agent-shells.ts`),别的工具画了按钮也停不掉。写成注册表里的一行、
   * 而不是卡片里的 `toolName === 'Bash'`,是为了让「哪些工具可停」和
   * 「哪些工具长什么样」住在同一张表里 —— 下一个可停的工具只要在这儿加一个字段。
   */
  stoppable?: boolean
}

// ─────────────────────────── 取值原语(全部对 unknown 安全) ───────────────────────────

/** 安全取字符串字段;不是对象、字段缺失、类型不符 → `''` */
export function pick(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return ''
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

/** 安全取数组字段;拿不到 → 空数组 */
function pickArray(input: unknown, key: string): readonly unknown[] {
  if (typeof input !== 'object' || input === null) return []
  const v = (input as Record<string, unknown>)[key]
  return Array.isArray(v) ? v : []
}

/**
 * 路径尾段。**同时按 `/` 和 `\` 切** —— Windows 上传进来的是反斜杠路径,
 * 只切正斜杠会让整条 `C:\a\b\c.ts` 原样显示,把标题撑爆。
 */
export function base(path: string): string {
  if (path === '') return ''
  const trimmed = path.replace(/[/\\]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const name = at >= 0 ? trimmed.slice(at + 1) : trimmed
  return name === '' ? path : name
}

/**
 * 截断到 n 字符并加省略号。
 *
 * 顺手把换行折成空格:多行 shell 命令直接进标题会把单行布局撑成三行,
 * 而标题行的高度是折叠列表能否保持整齐的关键。
 */
export function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`
}

/** `create_pull_request` → `create pull request` —— MCP 工具名的可读化 */
export function humanize(s: string): string {
  return s.replace(/[_-]+/g, ' ').trim()
}

/**
 * `mcp__github-enterprise__create_pr` → `{ server: 'github-enterprise', tool: 'create_pr' }`
 *
 * ★ **入参实际是 `externalName`,不是 `internalId`。**
 *
 * `agent-session.ts` 发 `tool_start` 时带的是 `tool.externalName`,而且有一条测试
 * 专门钉住这件事(`agent-session.test.ts` 的「tool_start 用的是 externalName,
 * 与转录里的名字一致」)—— 因为**已落盘的转录里存的就是 externalName**,
 * 改发射端会让所有历史转录的工具名对不上。所以适配放在这一侧,不动发射端。
 *
 * 对内置工具两者相同(`Read` / `Bash` 都短且合法,`ToolNamer.allocate` 原样返回),
 * 查表不受影响。只有超长的 MCP 名会被截断并追加 8 位 FNV 哈希,
 * 于是这里要把那个后缀剥掉,否则标题会显示成 `create pull request 3a7f21b9`。
 */
export function parseMcpId(internalId: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(internalId)
  if (!m) return null
  const server = m[1]
  const rawTool = m[2]
  if (server === undefined || server === '' || rawTool === undefined || rawTool === '') return null
  return { server, tool: stripNameHash(internalId, rawTool) }
}

/**
 * 剥掉 `ToolNamer` 为去重追加的 `_xxxxxxxx` 后缀。
 *
 * ★ **只在名字确实接近长度上限时才剥**。哈希只有在原名超过 64 字符
 * (`EXTERNAL_NAME_MAX`)时才会被追加,所以短名一律原样返回 ——
 * 否则一个真名就叫 `sync_1a2b3c4d` 的工具会被无辜切掉尾巴。
 */
function stripNameHash(fullName: string, tool: string): string {
  if (fullName.length < 55) return tool
  const stripped = tool.replace(/_[0-9a-f]{8}$/, '')
  return stripped === '' ? tool : stripped
}

/** URL 的主机名;解析不了就原样截断(流式中途的半截 URL 走这条) */
function hostOf(url: string): string {
  if (url === '') return ''
  try {
    return new URL(url).hostname
  } catch {
    return clip(url, 30)
  }
}

/** 输出的行数。空输出算 0 行,末尾换行不重复计数。 */
function lineCount(output: ToolOutput | undefined): number | undefined {
  if (output === undefined) return undefined
  const c = output.content
  if (c === '') return 0
  return c.replace(/\n$/, '').split('\n').length
}

/**
 * 带缺省的标题拼接:字段取不到时只显示动词。
 *
 * 「读取…」比「读取 」或「读取 undefined」都好 —— 前者读起来像正在进行,
 * 后者看着像 bug。流式中途每个工具卡片都会经过这条路径。
 */
function withTarget(verb: string, target: string): string {
  return target === '' ? `${verb}…` : `${verb} ${target}`
}

// ─────────────────────────── 各形态的摘要提取 ───────────────────────────

function readSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  const n = lineCount(o)
  return n === undefined ? undefined : `${String(n)} 行`
}

function lsSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  const n = lineCount(o)
  return n === undefined ? undefined : `${String(n)} 项`
}

/**
 * Write 的输出形如 `Created a.ts (12 lines, 340 bytes)` / `Overwrote …`。
 *
 * 正则失败就退回 undefined 而不是猜 —— 摘要错了比没有更糟:
 * 用户会拿它当真,而它恰恰是最不该被信错的那类数字。
 */
function writeSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  if (o === undefined) return undefined
  const created = /^Created\b/i.test(o.content)
  const m = /\((\d+)\s+lines?/i.exec(o.content)
  const lines = m?.[1]
  if (lines === undefined) return created ? '新建' : undefined
  return created ? `新建 ${lines} 行` : `${lines} 行`
}

/** Edit 的输出形如 `Edited a.ts: replaced 3 occurrence(s).` */
function editSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  if (o === undefined) return undefined
  const m = /replaced\s+(\d+)\s+occurrence/i.exec(o.content)
  const n = m?.[1]
  return n === undefined ? undefined : `替换 ${n} 处`
}

function globSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  const n = lineCount(o)
  return n === undefined ? undefined : `${String(n)} 个文件`
}

function grepSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  const n = lineCount(o)
  return n === undefined ? undefined : `${String(n)} 处`
}

/**
 * TodoWrite 的摘要从**入参**算,不从输出算。
 *
 * 理由:入参就是完整清单(工具契约明确要求「ALWAYS send the WHOLE list」),
 * 而输出只是一句确认。从入参算既准确又不依赖输出文案的措辞。
 */
function todoSummary(i: unknown): string | undefined {
  const todos = pickArray(i, 'todos')
  if (todos.length === 0) return undefined
  let done = 0
  for (const t of todos) {
    if (typeof t === 'object' && t !== null && (t as Record<string, unknown>).status === 'completed')
      done += 1
  }
  return `${String(done)}/${String(todos.length)}`
}

function webFetchSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  if (o === undefined) return undefined
  const bytes = o.originalBytes ?? o.content.length
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${String(bytes)}B`
}

function webSearchSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  const n = lineCount(o)
  return n === undefined ? undefined : `${String(n)} 条`
}

/**
 * Bash:失败时优先显示退出码(`Command exited with code 127.`),
 * 成功时显示输出行数。
 *
 * 退出码是排查 shell 失败**唯一最有信息量的一个数字** —— 127 是命令不存在、
 * 130 是被中断、1 是通用失败,它们指向完全不同的下一步。把它放在折叠态右侧,
 * 用户不展开就能分辨。
 */
function bashSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  if (o === undefined) return undefined
  const m = /exited with code (\d+)/i.exec(o.content)
  const code = m?.[1]
  if (code !== undefined) return `退出码 ${code}`
  if (o.content.startsWith('(command succeeded with no output)')) return '无输出'
  const n = lineCount(o)
  return n === undefined ? undefined : `${String(n)} 行输出`
}

/**
 * `BashOutput`:折叠态右侧显示那条后台 shell 的**状态**,不是行数。
 *
 * 一次回读最值得一眼看见的是「它还活着吗 / 退出码是几」—— 行数会随轮询忽多忽少,
 * 而状态正好是模型下一步要据以决定的那件事。输出首行形如
 * `Shell bash_1 (npm run dev) is still running.`
 */
function bashOutputSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  if (o === undefined) return undefined
  if (/is still running/.test(o.content)) return '运行中'
  if (/was killed/.test(o.content)) return '已停止'
  const m = /exited with code (\d+)/i.exec(o.content)
  const code = m?.[1]
  return code === undefined ? undefined : `退出码 ${code}`
}

/** MCP / 未知工具:拿输出首行当摘要 —— 这是唯一通用且几乎总有意义的东西 */
function firstLineSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  if (o === undefined) return undefined
  const first = o.content.split('\n', 1)[0] ?? ''
  const text = clip(first, 32)
  return text === '' ? undefined : text
}

const WEEKDAY_MARKS = ['日', '一', '二', '三', '四', '五', '六'] as const

/**
 * 定时任务的规则摘要,从**入参**算。
 *
 * ★ 折叠态右侧那一格是用户唯一不展开就能看见「到底定在什么时候」的地方 ——
 * 而「模型把任务定错了时间」正是这四个工具最需要被一眼看穿的失误。
 * 规则形状对不上(流式中途的半截 JSON)就返回 undefined,不猜。
 */
function scheduleSummary(i: unknown): string | undefined {
  if (typeof i !== 'object' || i === null) return undefined
  const raw = (i as Record<string, unknown>)['schedule']
  if (typeof raw !== 'object' || raw === null) return undefined
  const rule = raw as Record<string, unknown>
  const time = typeof rule['time'] === 'string' ? rule['time'] : ''
  if (rule['kind'] === 'once') {
    const at = typeof rule['at'] === 'string' ? rule['at'] : ''
    return at === '' ? undefined : at.replace('T', ' ')
  }
  if (rule['kind'] === 'daily') return time === '' ? undefined : `每天 ${time}`
  if (rule['kind'] === 'weekly') {
    const days = Array.isArray(rule['weekdays']) ? rule['weekdays'] : []
    const marks = days.map((d) => (typeof d === 'number' ? WEEKDAY_MARKS[d] : undefined)).filter((m) => m !== undefined)
    if (marks.length === 0 || time === '') return undefined
    return `周${marks.join('')} ${time}`
  }
  return undefined
}

/** `ListScheduledTasks` 的输出是一段 JSON,里面的 `count` 就是条数。 */
function scheduledListSummary(_i: unknown, o: ToolOutput | undefined): string | undefined {
  if (o === undefined) return undefined
  const m = /"count":\s*(\d+)/.exec(o.content)
  const n = m?.[1]
  return n === undefined ? '0 条' : `${n} 条`
}

// ─────────────────────────── 注册表 ───────────────────────────

/**
 * ★ 键是 `internalId`(`Read` / `Bash` / `web_search` …),与
 * `kernel/tool/builtin/index.ts` 的清单一一对应。
 * 新增内置工具必须在这里加一行,否则 `index.test.ts` 会失败。
 */
const REGISTRY: Record<string, ToolPresenter> = {
  Read: {
    shape: 'read',
    title: (i) => withTarget('读取', base(pick(i, 'file_path'))),
    summary: readSummary
  },
  LS: {
    shape: 'read',
    title: (i) => withTarget('列目录', base(pick(i, 'path'))),
    summary: lsSummary
  },
  Write: {
    shape: 'mutate',
    title: (i) => withTarget('写入', base(pick(i, 'file_path'))),
    summary: writeSummary
  },
  Edit: {
    shape: 'mutate',
    title: (i) => withTarget('编辑', base(pick(i, 'file_path'))),
    summary: editSummary
  },
  Glob: {
    shape: 'search',
    title: (i) => withTarget('查找', clip(pick(i, 'pattern'), 32)),
    summary: globSummary
  },
  Grep: {
    shape: 'search',
    title: (i) => withTarget('搜索', clip(pick(i, 'pattern'), 32)),
    summary: grepSummary
  },
  Bash: {
    shape: 'command',
    /**
     * 优先用模型自己写的 `description`(工具 schema 里要求「5-10 words」),
     * 它比命令本身更接近「这一步在干什么」;没有才退回命令原文。
     */
    title: (i) => {
      const desc = pick(i, 'description')
      if (desc !== '') return clip(desc, 40)
      return withTarget('执行', clip(pick(i, 'command'), 40))
    },
    summary: bashSummary,
    stoppable: true
  },
  BashOutput: {
    shape: 'command',
    title: (i) => withTarget('读后台输出', pick(i, 'bash_id')),
    summary: bashOutputSummary
  },
  KillShell: {
    shape: 'command',
    title: (i) => withTarget('停止后台命令', pick(i, 'shell_id'))
  },
  WebFetch: {
    shape: 'network',
    title: (i) => withTarget('抓取', hostOf(pick(i, 'url'))),
    summary: webFetchSummary
  },
  web_search: {
    shape: 'network',
    title: (i) => withTarget('搜索网络', clip(pick(i, 'query'), 32)),
    summary: webSearchSummary
  },
  TodoWrite: {
    shape: 'orchestration',
    title: () => '更新任务清单',
    summary: (i) => todoSummary(i)
  },
  Task: {
    shape: 'orchestration',
    title: (i) => {
      const desc = pick(i, 'description')
      if (desc !== '') return `子代理:${clip(desc, 30)}`
      return withTarget('子代理', pick(i, 'subagent_type'))
    },
    summary: (i) => {
      const t = pick(i, 'subagent_type')
      return t === '' ? undefined : t
    }
  },
  Skill: {
    shape: 'orchestration',
    title: (i) => withTarget('技能', pick(i, 'name'))
  },
  ListScheduledTasks: {
    shape: 'orchestration',
    title: () => '查看定时任务',
    summary: scheduledListSummary
  },
  CreateScheduledTask: {
    shape: 'orchestration',
    title: (i) => withTarget('新建定时任务', clip(pick(i, 'name'), 24)),
    summary: (i) => scheduleSummary(i)
  },
  UpdateScheduledTask: {
    shape: 'orchestration',
    /** 改名时显示新名字,只改时间时退回 id —— 两种都比只显示动词有用 */
    title: (i) => {
      const name = pick(i, 'name')
      return withTarget('修改定时任务', name === '' ? clip(pick(i, 'task_id'), 14) : clip(name, 24))
    },
    summary: (i) => scheduleSummary(i)
  },
  DeleteScheduledTask: {
    shape: 'orchestration',
    title: (i) => withTarget('删除定时任务', clip(pick(i, 'task_id'), 14))
  },
  echo: {
    shape: 'external',
    title: () => 'echo',
    summary: firstLineSummary
  }
}

/** 名字完全认不出来时的兜底。保持现状行为:通用 JSON 详情。 */
const FALLBACK: ToolPresenter = {
  shape: 'external',
  title: () => '工具调用',
  summary: firstLineSummary
}

// ─────────────────────────── 插件贡献的 presenter(注入层) ───────────────────────────
//
// ★ REGISTRY 之上唯一的可变层。插件的 presenter **算不出来**(依赖清单里的 shape/card
// 模板 + i18n),所以由渲染层在 catalog 加载时**构建好闭包再注入**——把 t()/locale 留在
// 渲染层,这个 shared 模块仍然不碰 store。注入是**全量替换**(与 plugins store 的替换式
// 一致):每次拿整份 catalog 重建,避免残留已卸载插件的条目。
//
// ★ 带 version + 订阅:`presenterOf` 是命令式查表,注入这张 Map 不会触发 React 重渲;
// 已提交(静态)的工具卡片若 presenter 迟到,不订阅就会永久停在兜底标题。消费方
// (parts.tsx)用 `useSyncExternalStore` 订阅 `subscribePluginPresenters` 拿到重渲。
const pluginPresenters = new Map<string, ToolPresenter>()
let pluginPresentersVersion = 0
const pluginPresenterListeners = new Set<() => void>()

/** 全量替换插件 presenter 表。键是 externalName(转录里存的那个)。 */
export function registerPluginPresenters(entries: ReadonlyArray<readonly [string, ToolPresenter]>): void {
  pluginPresenters.clear()
  for (const [externalName, presenter] of entries) pluginPresenters.set(externalName, presenter)
  pluginPresentersVersion += 1
  for (const listener of pluginPresenterListeners) listener()
}

/** 主要给测试用:清空注入层,`beforeEach` 复位,避免用例间串状态。 */
export function clearPluginPresenters(): void {
  if (pluginPresenters.size === 0) return
  pluginPresenters.clear()
  pluginPresentersVersion += 1
  for (const listener of pluginPresenterListeners) listener()
}

/** `useSyncExternalStore` 的快照。 */
export function pluginPresentersSnapshot(): number {
  return pluginPresentersVersion
}

/** 订阅注入层变更 —— 见上方注释里「静态卡片 presenter 迟到」那段。 */
export function subscribePluginPresenters(listener: () => void): () => void {
  pluginPresenterListeners.add(listener)
  return () => pluginPresenterListeners.delete(listener)
}

/**
 * 四级查找:内置注册表 → MCP 拆名 → 插件注入 → 可读名兜底。
 *
 * 每一级都会返回一个可用的 presenter,**永远不返回 undefined** ——
 * 调用方不需要写空判断,这是让 `parts.tsx` 里那段渲染保持平铺直叙的前提。
 */
export function presenterOf(name: string): ToolPresenter {
  const hit = REGISTRY[name]
  if (hit !== undefined) return hit

  const mcp = parseMcpId(name)
  if (mcp !== null) {
    return {
      shape: 'external',
      title: () => `${mcp.server} · ${clip(humanize(mcp.tool), 28)}`,
      summary: firstLineSummary
    }
  }

  // 插件贡献的 presenter。放在 MCP 之后、humanize 兜底之前:插件工具的
  // externalName 不匹配 `mcp__` 拆名规则,会一路落到这里;注入了就用注入的,
  // 没注入(catalog 还没加载 / 这个工具没声明卡片)则继续走可读名兜底。
  const injected = pluginPresenters.get(name)
  if (injected !== undefined) return injected

  // 认不出来但名字本身可读时,显示名字比显示「工具调用」有用得多。
  // Skill 提供的工具、以及将来任何新来源都会落在这里。
  //
  // ★ **必须回填 FALLBACK**:`humanize` 会把下划线全换成空格,
  // 于是一个叫 `____` 的工具(消毒后的中文名就长这样,见 naming.ts 的
  // sanitizeToolName)会得到一个空标题 —— 界面上是一行只有图标的空白,
  // 看着像渲染坏了。单测里那条「永不返回空标题」钉的就是这里。
  const readable = clip(humanize(name), 32)
  if (readable !== '') {
    return {
      shape: 'external',
      title: () => readable,
      summary: firstLineSummary
    }
  }
  return FALLBACK
}

/** 测试与「新增工具忘了登记」检查用:注册表已知的全部 internalId。 */
export function registeredToolIds(): readonly string[] {
  return Object.keys(REGISTRY)
}

/** 某个 internalId 是否已在注册表里(MCP 与未知名不算)。 */
export function isRegisteredTool(internalId: string): boolean {
  return internalId in REGISTRY
}
