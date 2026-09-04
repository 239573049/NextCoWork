/**
 * 设置浮层的导航表 + 可搜索行目录。
 *
 * **纯数据,不 import 任何 React/lucide** —— 图标在同目录的 `icons.ts`
 * (照 `shell/icons.ts` 的先例)。这样这个文件连同 `matchRows` 能在
 * vitest 的 node 环境里直接测:`vitest.config.ts` 只匹配 `.ts`,没有 jsdom。
 *
 * ★ **十项是照参考图铺的,不是照「我们实现了什么」铺的。** 其中账户 / 钱包 /
 * 每日回顾在方案 §10 是**明确砍掉**的(侧边栏左下角那块之所以从「账户」换成
 * 「设置入口」就是因为这个),电脑操作是步骤 9。这四页在界面上直说被砍了或
 * 排在第几步,不做成「即将推出」—— 后者是在骗自己。
 */

export type SettingsPageId =
  | 'account'
  | 'wallet'
  | 'general'
  | 'preference'
  | 'model'
  | 'review'
  | 'connection'
  | 'computer'
  | 'data'
  | 'about'

export interface SettingsSub {
  id: string
  label: string
}

export interface SettingsPage {
  id: SettingsPageId
  label: string
  /** 子 Tab(参考图里「通用」下的 应用|Agent|任务)。没有就是单页 */
  subs?: readonly SettingsSub[]
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'account', label: '账户' },
  { id: 'wallet', label: '钱包' },
  {
    id: 'general',
    label: '通用',
    subs: [
      { id: 'app', label: '应用' },
      { id: 'agent', label: 'Agent' },
      { id: 'task', label: '任务' }
    ]
  },
  { id: 'preference', label: '偏好' },
  { id: 'model', label: '模型' },
  { id: 'review', label: '每日回顾' },
  {
    id: 'connection',
    label: '连接',
    subs: [
      { id: 'gateway', label: '开放网关' },
      { id: 'proxy', label: '代理' }
    ]
  },
  { id: 'computer', label: '电脑操作' },
  { id: 'data', label: '数据' },
  { id: 'about', label: '关于' }
]

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'general'

export const PAGE_LABEL: Readonly<Record<SettingsPageId, string>> = Object.fromEntries(
  SETTINGS_PAGES.map((p) => [p.id, p.label])
) as Record<SettingsPageId, string>

export interface SettingsRow {
  page: SettingsPageId
  /** 所属子 Tab 的 id。搜索命中后跳过去要连子 Tab 一起切 */
  sub?: string
  title: string
  /**
   * 额外的可搜索词。中英双写是这里唯一有价值的东西 ——
   * 用户十有八九会打 `proxy` 而不是「代理」,打 `theme` 而不是「主题」。
   */
  keywords?: readonly string[]
}

/**
 * ★ **这张表是唯一事实来源,页面组件从它取标题渲染。**
 * 表和界面各写一份的话,搜出来点过去会落在一个没有那一行的页面上,
 * 而这种漂移没有任何机制会报警。
 */
export const SETTINGS_INDEX: readonly SettingsRow[] = [
  // ── 通用 ──
  { page: 'general', sub: 'app', title: '界面语言', keywords: ['language', 'locale', '语言'] },
  { page: 'general', sub: 'app', title: '任务完成提示音', keywords: ['notification', 'sound', '通知'] },
  { page: 'general', sub: 'app', title: '权限审批提示音', keywords: ['notification', 'sound', '通知'] },
  { page: 'general', sub: 'app', title: '计划审批提示音', keywords: ['notification', 'sound', '通知'] },
  { page: 'general', sub: 'agent', title: '默认权限档位', keywords: ['permission', '审批', '权限'] },
  { page: 'general', sub: 'task', title: '单对话子代理上限', keywords: ['subagent', '子代理', '并发'] },
  { page: 'general', sub: 'task', title: '子代理并发上限', keywords: ['subagent', '子代理', '并发'] },

  // ── 偏好 ──
  { page: 'preference', title: '主题', keywords: ['theme', 'dark', 'light', '深色', '浅色'] },
  { page: 'preference', title: '打开设置', keywords: ['shortcut', 'keybinding', '快捷键'] },

  // ── 模型 ──
  { page: 'model', title: '默认模型', keywords: ['model', '模型'] },
  { page: 'model', title: '默认子代理模型', keywords: ['subagent', 'model', '子代理'] },

  // ── 连接 ──
  { page: 'connection', sub: 'gateway', title: '启用本地网关', keywords: ['gateway', '网关'] },
  { page: 'connection', sub: 'gateway', title: '期望端口', keywords: ['port', 'gateway', '端口'] },
  { page: 'connection', sub: 'gateway', title: '故障切换', keywords: ['failover', '切换'] },
  { page: 'connection', sub: 'proxy', title: '启用代理', keywords: ['proxy', '代理'] },
  { page: 'connection', sub: 'proxy', title: '代理地址', keywords: ['proxy', 'url', '代理'] },

  // ── 数据 ──
  { page: 'data', title: '数据库大小', keywords: ['storage', 'database', '存储'] },
  { page: 'data', title: '对话数量', keywords: ['storage', '统计'] },
  { page: 'data', title: '消息数量', keywords: ['storage', '统计'] },
  { page: 'data', title: '优化存储', keywords: ['vacuum', 'storage', '清理'] },

  // ── 关于 ──
  { page: 'about', title: '版本', keywords: ['version', 'about', '版本'] }
]

/**
 * 跨页过滤。纯函数 —— 空查询返回空数组(调用点据此决定「显示正常页面」
 * 而不是「显示全部结果」;返回全表的话一打开设置就是一屏搜索结果)。
 */
export function matchRows(query: string): SettingsRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return SETTINGS_INDEX.filter((r) => {
    if (r.title.toLowerCase().includes(q)) return true
    if (PAGE_LABEL[r.page].toLowerCase().includes(q)) return true
    return (r.keywords ?? []).some((k) => k.toLowerCase().includes(q))
  })
}

/** 页面本身命中(用户打「关于」时那一页没有任何行,但页名该出现) */
export function matchPages(query: string): SettingsPage[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return SETTINGS_PAGES.filter((p) => p.label.toLowerCase().includes(q))
}
