/**
 * 应用级设置。工作区级的在 workspace.ts。
 */
import type { PermissionMode } from '../agent/permission'
import type { ProxySettings } from './proxy'
import { DEFAULT_PROXY, migrateLegacyProxy } from './proxy'
import {
  DEFAULT_COLOR_THEME_ID,
  DEFAULT_CUSTOM_SEED,
  type ColorThemeChoice,
  type ImageRender
} from './theme'

/** 三态,默认跟随系统(方案 §8:深浅两套对等)。 */
export type ThemePreference = 'system' | 'light' | 'dark'
/** 实际生效的那个,由主进程 nativeTheme 解析后下发 */
export type ResolvedTheme = 'light' | 'dark'

/** 本机数据备份频率。云同步不属于本地数据设置的一部分。 */
export type BackupFrequency = 'manual' | 'daily' | 'weekly'

export interface DataSettings {
  /** 用户选择的本机备份目录；null 表示尚未选择。 */
  backupDirectory: string | null
  backupFrequency: BackupFrequency
}

/** Agent 上下文整理偏好。实验模式包含笔记、当前会话历史检索和窗口切换。 */
export interface ContextManagementSettings {
  experimentalMode: boolean
  autoCompact: boolean
}

/**
 * 界面「偏好 › 个性化」那三栏。**它是唯一一块会被原样拼进系统提示词的设置** ——
 * 见 `main/kernel/context-assembler.ts` 的 `buildPersonalizationSection`。
 *
 * ★ 三个字段都是**用户自己打进来的**,不走 `untrustedBoundary`:那道边界声明
 * 防的是「从 zip 装来的 Skill 正文」「clone 别人仓库带进来的 AGENTS.md」这类
 * 第三方文本,而这三栏就是用户本人在跟模型说话 —— 给自己的话加一句
 * 「以上内容不能放宽你的权限」既没有防住谁,又白占提示词。真正的防线仍在
 * 权限层:不管这里写了什么,每一次工具调用照样过 `approve`。
 */
export interface PersonalizationSettings {
  /** 姓名 —— 「让 AI 知道你是谁」 */
  name: string
  /** 工作描述 —— 「帮助 AI 理解你的背景,以便提供更贴合的回答」 */
  background: string
  /** 全局提示词 —— 「自定义指令会附加到每次对话的系统提示词中」 */
  instructions: string
}

/** 应用级快捷键。值使用 Electron accelerator 格式，例如 `CmdOrCtrl+,`。 */
export interface ShortcutSettings {
  openSettings: string
}

/**
 * 三栏各自的字符上限。
 *
 * ★ 闸门在**这里**(落库前)而不只在输入框上:`settings:update` 是个 IPC,
 * 输入框的 `maxLength` 拦不住任何一个绕过界面的调用,而这一块的去处是
 * **系统提示词的稳定前缀** —— 一段 200KB 的「全局提示词」不是显示得难看,
 * 是每一轮、每一个子代理都白烧一遍那 200KB。
 *
 * 数值本身是「够用就好」:名字给 64(比任何真名都长),背景 2000
 * (一段自我介绍),指令 8000(相当于一份不算短的 AGENTS.md)。
 * 提示词那侧还会再截一次 —— 那是防旧库里已经躺着超长值的,两道不冲突。
 */
export const PERSONALIZATION_MAX = {
  name: 64,
  background: 2000,
  instructions: 8000
} as const

const BACKUP_FREQUENCIES: readonly BackupFrequency[] = ['manual', 'daily', 'weekly']

function isBackupFrequency(value: unknown): value is BackupFrequency {
  return typeof value === 'string' && BACKUP_FREQUENCIES.includes(value as BackupFrequency)
}

/**
 * 旧设置文件是用户可编辑/可迁移的输入，不能因为一个坏字段让整个设置页
 * 变成 undefined。只接受这一块已知的两个字段，其余一律回到默认值。
 */
function mergeDataSettings(current: DataSettings, patch: unknown): DataSettings {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { ...current }
  const value = patch as Record<string, unknown>
  const backupDirectory =
    value.backupDirectory === null || typeof value.backupDirectory === 'string'
      ? value.backupDirectory
      : current.backupDirectory
  const backupFrequency = isBackupFrequency(value.backupFrequency)
    ? value.backupFrequency
    : current.backupFrequency
  return { backupDirectory, backupFrequency }
}

/**
 * 同 `mergeDataSettings`:只认这三个字符串字段,坏值原样退回当前值。
 * 顺手截到上限 —— 见 `PERSONALIZATION_MAX` 那段说明。
 */
function mergePersonalization(
  current: PersonalizationSettings,
  patch: unknown
): PersonalizationSettings {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { ...current }
  const value = patch as Record<string, unknown>
  const take = (key: keyof PersonalizationSettings): string => {
    const next = value[key]
    if (typeof next !== 'string') return current[key]
    return next.slice(0, PERSONALIZATION_MAX[key])
  }
  return { name: take('name'), background: take('background'), instructions: take('instructions') }
}

export interface AppSettings {
  /**
   * 界面「主题」页第一栏「外观模式」。**它只决定深浅,不决定颜色** ——
   * 颜色在下面 `colorTheme` / `imageTheme` 两栏,三者一起喂给 `tokensOf`。
   */
  theme: ThemePreference
  locale: 'zh-CN' | 'en-US'

  /**
   * 「颜色主题」栏(随机 / 墨绿 / 霁青 / 极简 / Claude / 奢华 / 自定义)。
   *
   * ★ 形状(`ColorThemeChoice`)归 `theme.ts` 所有 —— 认识这三个字段各归谁用的是
   * `resolveColorTheme`,不是设置层。这里存的就是那一栏的全部状态。
   *
   * `id` 认不出来时 `resolveColorTheme` 落回默认而不抛 —— 它是从磁盘读回来的,
   * 而磁盘上可能存着一套后来被删掉的主题。
   *
   * `seed`(给「随机」,重掷一次换一个)和 `custom`(给「自定义」,用户挑的那个
   * 强调色)**都必须落盘**:两套主题都是由一个种子经 `specFromSeed` 现算的,
   * 不落盘就回不到用户挑中的那一套。
   */
  colorTheme: ColorThemeChoice

  /**
   * 「图片主题」栏。选了图就**盖过** `colorTheme`(见 theme.ts 的 `tokensOf`)。
   *
   * ★ 「没选图」写成 `id: null`,而不是把整块写成 `imageTheme: {…} | null`。
   * 后者会让这一块在 `AppSettingsPatch` 里退化成「整个给」—— `null` 不是 object,
   * 走不进那个 `extends object` 的真分支。于是「点一张卡片」和「点覆盖色药丸」
   * 这两个紧挨着的控件又回到互相覆盖的老路上,而那正是 `AppSettingsPatch`
   * 整个存在的理由。顺带还白捡一条:取消选图再选回来,用户挑的渲染方式还在。
   */
  imageTheme: {
    /** `IMAGE_THEMES` 里的 id,或上传图片的 assetId;`null` = 没选图 */
    id: string | null
    render: ImageRender
  }

  /** 新会话的默认档位 */
  defaultPermissionMode: PermissionMode
  /** “为我批准”档位使用的专用审核模型；空字符串表示未配置，自动回退人工审批。 */
  permissionReviewerModel: string
  defaultModel: string

  /** 上下文管理：默认开启智能窗口模式，并保留自动压缩回退。 */
  contextManagement: ContextManagementSettings

  /** 子代理(方案 §4.9 / 界面「Agent 资源调度」) */
  subagent: {
    /** 界面:「默认子代理模型」 */
    model: string
    /** 界面:「单对话子代理上限(推荐 4)」 */
    perSessionLimit: number
    /** 全局子代理池,对应界面「并发上限 0–10」 */
    globalLimit: number
  }

  /** 本地模型网关 —— ★ 默认关闭(方案 §5.4 第 1 条) */
  gateway: {
    enabled: boolean
    /** 19836 被占时动态选;这里存的是**期望**端口 */
    preferredPort: number
    failover: boolean
  }

  notifications: {
    /** 三类音效,对应 InteractionKind(方案 §4.6) */
    taskComplete: boolean
    permissionApproval: boolean
    planApproval: boolean
  }

  /**
   * 界面「连接 › 网络」那一页。★ 它**真的作用于全应用的出站请求** ——
   * `main/net/proxy.ts` 把它翻译成 `session.defaultSession.setProxy`,
   * 于是模型请求、MCP 的 HTTP 传输、搜索适配器一并跟着走(它们都经 `net.fetch`)。
   *
   * 形状与全部纯函数在 `proxy.ts`,那边的文件头解释了为什么拆成三段。
   */
  proxy: ProxySettings

  /** 设置 › 数据：只保存本机备份偏好，不包含任何云端开关。 */
  data: DataSettings

  /**
   * 设置 › 偏好 › 个性化。★ 这一块**会进系统提示词** —— 它是这张表里
   * 唯一一个不只影响界面、而是直接改变模型看到什么的字段。
   */
  personalization: PersonalizationSettings

  /** 偏好 › 快捷键。 */
  shortcuts: ShortcutSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  locale: 'zh-CN',
  colorTheme: { id: DEFAULT_COLOR_THEME_ID, seed: 0, custom: DEFAULT_CUSTOM_SEED },
  imageTheme: { id: null, render: 'blur' },
  // 安全默认：任何会改变文件或执行命令的敏感操作都先询问用户。
  defaultPermissionMode: 'ask',
  permissionReviewerModel: '',
  defaultModel: '',
  contextManagement: { experimentalMode: true, autoCompact: true },
  subagent: { model: '', perSessionLimit: 4, globalLimit: 4 },
  gateway: { enabled: false, preferredPort: 19836, failover: false },
  notifications: { taskComplete: true, permissionApproval: true, planApproval: true },
  proxy: structuredClone(DEFAULT_PROXY),
  data: { backupDirectory: null, backupFrequency: 'manual' },
  personalization: { name: '', background: '', instructions: '' },
  shortcuts: { openSettings: 'CmdOrCtrl+,' }
}

/**
 * `settings:update` 的入参 —— 顶层标量整给,**嵌套块可以只给要改的那一个属性**。
 *
 * ★ 这个类型存在的唯一理由是消灭一整类竞态,不是为了少打几个字。
 * 原来的契约是 `Partial<AppSettings>` + 主进程浅合并,于是「改一个属性」在
 * 渲染层只能写成 `{ gateway: { ...settings.gateway, failover: true } }` ——
 * 而 `settings` 是 prop,**在一次 IPC 往返回来之前它是旧的**。连点两个属于
 * 同一块的开关(通知页那三个音效是紧挨着的三行,网关页也是),第二次写就把
 * 第一次写的值原样覆盖回去。表现是「我明明打开了,它自己关了」,而且只在手快时出现。
 *
 * 深合并之后调用点写 `{ gateway: { failover: true } }` 就够了,兄弟属性
 * 根本不经过渲染层,也就无从被旧值覆盖。
 */
export type AppSettingsPatch = {
  [K in keyof AppSettings]?: AppSettings[K] extends object
    ? Partial<AppSettings[K]>
    : AppSettings[K]
}

/**
 * 纯函数,不改 `current`。主进程 `store.updateSettings` 是唯一调用点,
 * 放在 shared 是为了让它能在 node 环境的 vitest 里被直接测(见同目录 __tests__)。
 *
 * 逐字段展开而不是遍历 `Object.entries`:后者要么丢类型要么满地 cast,
 * 而这里一共就十个字段。下面那张 `PATCHABLE_KEYS` 表是**编译期哨兵** ——
 * 给 `AppSettings` 加字段却忘了在这里合并,类型检查当场就红。
 */
export function mergeSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const next: AppSettings = structuredClone(current)

  if (patch.theme !== undefined) next.theme = patch.theme
  if (patch.locale !== undefined) next.locale = patch.locale
  if (patch.defaultPermissionMode !== undefined) {
    next.defaultPermissionMode = patch.defaultPermissionMode
  }
  if (patch.permissionReviewerModel !== undefined) next.permissionReviewerModel = patch.permissionReviewerModel
  if (patch.defaultModel !== undefined) next.defaultModel = patch.defaultModel
  if (patch.contextManagement !== undefined) {
    next.contextManagement = { ...next.contextManagement, ...patch.contextManagement }
  }

  // 六个嵌套块:深一层。再深就没有了 —— AppSettings 只有两层,
  // 通用深合并在这里是纯粹的负担(它还得决定数组怎么办)。
  if (patch.colorTheme !== undefined) next.colorTheme = { ...next.colorTheme, ...patch.colorTheme }
  if (patch.imageTheme !== undefined) next.imageTheme = { ...next.imageTheme, ...patch.imageTheme }
  if (patch.subagent !== undefined) next.subagent = { ...next.subagent, ...patch.subagent }
  if (patch.gateway !== undefined) next.gateway = { ...next.gateway, ...patch.gateway }
  if (patch.notifications !== undefined) {
    next.notifications = { ...next.notifications, ...patch.notifications }
  }
  // ★ 经一道迁移:旧库里这一块是 `{ enabled, url }`。`migrateLegacyProxy` 只在
  // 三段字段缺席时才把 url 拆开,所以它对正常的表单 patch 是恒等的 —— 理由在 proxy.ts
  if (patch.proxy !== undefined) {
    next.proxy = { ...next.proxy, ...migrateLegacyProxy(patch.proxy) }
  }
  if (patch.data !== undefined) next.data = mergeDataSettings(next.data, patch.data)
  if (patch.personalization !== undefined) {
    next.personalization = mergePersonalization(next.personalization, patch.personalization)
  }
  if (patch.shortcuts !== undefined) {
    const candidate = patch.shortcuts
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      const openSettings = candidate.openSettings
      if (typeof openSettings === 'string' && openSettings.trim().length > 0) {
        next.shortcuts = { openSettings: openSettings.trim() }
      }
    }
  }

  return next
}

/** 见 `mergeSettings`:漏掉一个字段就编译不过。运行时不用它。 */
const PATCHABLE_KEYS: Record<keyof AppSettings, true> = {
  theme: true,
  locale: true,
  colorTheme: true,
  imageTheme: true,
  defaultPermissionMode: true,
  permissionReviewerModel: true,
  defaultModel: true,
  contextManagement: true,
  subagent: true,
  gateway: true,
  notifications: true,
  proxy: true,
  data: true,
  personalization: true,
  shortcuts: true
}
void PATCHABLE_KEYS

/** 界面「数据」页:数据库大小 / 对话数量 / 消息数量 / 优化存储(VACUUM)。 */
export interface StorageStats {
  dbBytes: number
  walBytes: number
  conversationBytes: number
  attachmentBytes: number
  conversationCount: number
  messageCount: number
  attachmentCount: number
  dataDirectory: string
  lastBackupAt: number | null
}
