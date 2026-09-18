/**
 * 插件清单 —— `package.json`,字段名尽量与 VS Code 同名。
 *
 * ## 为什么不用 zod
 *
 * 仓库里 zod 只出现在**主进程**(`defineTool` 的入参 schema)。这份清单类型
 * 渲染层也要用(插件详情页要列能力、贡献点),从 shared 引 zod 会把整个
 * 校验器拖进渲染 bundle,而渲染层一次都不需要**校验**清单 —— 它只读已经
 * 校验过的结果。所以这里是手写归一化器,和 `shared/domain/local-settings.ts`
 * 同一个路数。
 *
 * ## 校验的取向:**装载期严格,运行期宽容**
 *
 * 一份读不懂的清单**整份拒绝**,不做部分接受 —— 半份生效的插件会在某个
 * 贡献点上凭空消失,而诊断里只会写「清单有问题」,症状和原因对不上。
 * 但拒绝的方式是**返回错误,永不 throw**:一个坏插件不该让插件系统起不来
 * (同 `kernel/skill/load.ts` 的「一切失败变 diagnostics」)。
 */
import {
  PLUGIN_PERMISSIONS,
  isPluginPermission,
  type PluginPermission
} from './permission'

/** 与后端 `NameRegex` 同一形状。 */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** `publisher.name`。 */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/
/** 与后端 `SemVerRegex` 复用同一形状(不含 build metadata 的宽松版)。 */
export const PLUGIN_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/
/** 贡献点上的文案必须是这个形状 —— 引用 l10n bundle,不是裸文案。 */
export const L10N_REF_RE = /^%[A-Za-z0-9_][A-Za-z0-9_.-]*%$/

/**
 * 激活事件白名单。
 *
 * ★ `onStartup` 在枚举里,但**市场审核默认驳回**:每个激活的插件是一个
 * renderer 进程,它是这套架构下唯一的内存风险源。留在枚举里是因为确实有
 * 极少数插件需要它(比如注册一个全局状态栏读数),不留的话作者只能用
 * 一个匹配所有文件的 `onWorkspaceContains` glob 去伪装,那更糟 ——
 * 伪装出来的意图审核看不见。
 */
export const ACTIVATION_EVENT_PREFIXES = [
  'onCommand:',
  'onView:',
  'onCustomEditor:',
  'onTool:',
  'onWorkspaceContains:'
] as const

export const ACTIVATION_EVENT_LITERALS = ['onStartup'] as const

export interface PluginCommandContribution {
  command: string
  /** `%key%`,不是文案 */
  title: string
  icon?: string
}

export interface PluginMenuContribution {
  command: string
  /** `<group>@<order>`,照抄 VS Code */
  group?: string
  when?: string
}

export interface PluginCustomEditorContribution {
  viewType: string
  displayName: string
  selector: { filenamePattern: string }[]
  priority?: 'default' | 'option'
}

export interface PluginViewContribution {
  id: string
  title: string
  icon?: string
  /** 视图 HTML 在包内的相对路径 */
  path: string
}

/**
 * 工具卡片的形态 —— 决定折叠态图标与展开渲染器。
 *
 * ★ 字符串**内联**在这里,不 import `domain/tool-presenter` 的 `ToolShape`:
 * manifest 是纯清单解析,不该为一个枚举把渲染域拖进 import 图。两处取值必须一致
 * (渲染层拿这个字符串去 `SHAPE_ICON` / `DETAIL_RENDERERS` 查表)。
 */
export type PluginToolShape =
  | 'reasoning'
  | 'read'
  | 'mutate'
  | 'search'
  | 'command'
  | 'network'
  | 'orchestration'
  | 'external'

const TOOL_SHAPES: readonly PluginToolShape[] = [
  'reasoning',
  'read',
  'mutate',
  'search',
  'command',
  'network',
  'orchestration',
  'external'
]

export interface PluginToolContribution {
  name: string
  title: string
  icon?: string
  /** 折叠态卡片形态。缺省按 `external` 走。见 `PluginToolShape`。 */
  shape?: PluginToolShape
  /**
   * 折叠态标题 / 摘要模板。值是 `%l10nKey%`,渲染层 `t()` 之后再做 `{param}` 插值。
   *
   * ★ 只影响**展示**,不改工具行为。缺参时渲染层回退到静态标题,不漏花括号
   * (流式态入参可能是半截 JSON)。
   */
  card?: { title?: string; summary?: string }
}

/**
 * 工具返回 `frame` 卡片时,渲染层据 `viewType` 找到这张卡的 HTML。
 *
 * ★ 与 `views`(侧栏常驻视图)**分开声明**:卡片是内联、随聊天流滚动、
 * 只读数据单向推入、可回收的,生命周期与常驻视图不同,不复用同一贡献点。
 */
export interface PluginCardViewContribution {
  viewType: string
  /** 卡片 HTML 在包内的相对路径 */
  path: string
}

export interface PluginKeybindingContribution {
  command: string
  key: string
  when?: string
}

export interface PluginConfigurationProperty {
  type: 'boolean' | 'string' | 'number' | 'enum'
  title: string
  default?: boolean | string | number
  enum?: string[]
  description?: string
}

export interface PluginConfigurationContribution {
  title: string
  properties: Record<string, PluginConfigurationProperty>
}

export interface PluginContributes {
  commands: PluginCommandContribution[]
  menus: Record<string, PluginMenuContribution[]>
  customEditors: PluginCustomEditorContribution[]
  views: PluginViewContribution[]
  tools: PluginToolContribution[]
  /** 工具返回 `frame` 卡片时的 HTML 落点,按 viewType 索引 */
  cardViews: PluginCardViewContribution[]
  keybindings: PluginKeybindingContribution[]
  skills: { path: string }[]
  themes: { path: string }[]
  configuration?: PluginConfigurationContribution
  /**
   * 认得字段名、但这一版**不实现**的贡献点原样留着。
   *
   * ★ 留着不是为了将来好改,是为了**现在能报诊断**:装载时按这份列表给出
   * 「这个贡献点还没实现」的具体提示,而不是让插件作者对着「没有反应」发呆
   * (见 `main/plugin/unsupported.ts`)。
   */
  unsupported: string[]
}

export interface PluginManifest {
  /** `publisher.name` —— 全局唯一,插件的身份 */
  id: string
  name: string
  publisher: string
  displayName: string
  description: string
  version: string
  license?: string
  icon?: string
  categories: string[]
  keywords: string[]
  /** 简单 range:`^x.y.z` / `~x.y.z` / `>=x.y.z` / 精确 */
  engines: string
  /** 单文件 ESM 的相对路径 */
  main: string
  /** l10n 目录的相对路径 */
  l10n?: string
  activationEvents: string[]
  permissions: PluginPermission[]
  optionalPermissions: PluginPermission[]
  hostPermissions: string[]
  /**
   * `process.exec` 的命令白名单 —— 裸可执行名,不带路径也不带 `.exe` 之类的后缀。
   * 空数组 = 一条命令都不许跑(即便 `permissions` 里有 `process`)。
   */
  allowedCommands: string[]
  /**
   * 依赖的其它插件:`pluginId` → 版本 range(与 `engines` 同一套 range 语法)。
   *
   * ★ 声明依赖是**跨插件通信的准入门**:`ncw.plugins.connect(pluginId)` 只能连
   * 这里声明过的插件(外加 `plugins` 能力)。同时决定激活顺序 —— 依赖先醒。
   */
  dependencies: Record<string, string>
  contributes: PluginContributes
}

export interface ManifestError {
  /** 出问题的字段路径,给插件作者看的 */
  field: string
  message: string
}

export type ManifestParseResult =
  | { ok: true; manifest: PluginManifest; warnings: ManifestError[] }
  | { ok: false; errors: ManifestError[] }

/** 单份清单最多认多少个贡献项 —— 防一份被塞了几千项的清单把装载拖住。 */
const MAX_CONTRIBUTIONS_PER_KIND = 100

/**
 * 解析并校验一份 `package.json`。**永不 throw。**
 *
 * `known` 传的是宿主这一版认得的菜单 id / 贡献点名字;不认得的不报错、
 * 进 `unsupported`,由装载方转成诊断。
 */
export function parsePluginManifest(raw: unknown): ManifestParseResult {
  const errors: ManifestError[] = []
  const warnings: ManifestError[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: '', message: 'manifest must be a JSON object' }] }
  }
  const r = raw as Record<string, unknown>

  const name = str(r.name)
  if (!PLUGIN_NAME_RE.test(name)) errors.push({ field: 'name', message: 'must match ^[a-z0-9][a-z0-9-]{0,63}$' })
  const publisher = str(r.publisher)
  if (!PLUGIN_NAME_RE.test(publisher)) errors.push({ field: 'publisher', message: 'must match ^[a-z0-9][a-z0-9-]{0,63}$' })

  const version = str(r.version)
  if (!PLUGIN_VERSION_RE.test(version)) errors.push({ field: 'version', message: 'must be a semver string' })

  const displayName = str(r.displayName) || name
  const description = str(r.description)

  const engines = str((r.engines as Record<string, unknown> | undefined)?.nextcowork)
  if (engines === '') errors.push({ field: 'engines.nextcowork', message: 'is required' })
  else if (parseRange(engines) === null) errors.push({ field: 'engines.nextcowork', message: `unsupported range: ${engines}` })

  const main = str(r.main)
  if (main === '') errors.push({ field: 'main', message: 'is required' })
  else if (!isSafeRelativePath(main)) errors.push({ field: 'main', message: 'must be a relative path inside the package' })
  else if (!main.endsWith('.js')) errors.push({ field: 'main', message: 'must be a single-file ESM .js bundle' })

  const l10n = str(r.l10n)
  if (l10n !== '' && !isSafeRelativePath(l10n)) errors.push({ field: 'l10n', message: 'must be a relative path inside the package' })

  const icon = str(r.icon)
  if (icon !== '' && !isSafeRelativePath(icon)) errors.push({ field: 'icon', message: 'must be a relative path inside the package' })

  const activationEvents = strList(r.activationEvents).filter((event) => {
    if (isActivationEvent(event)) return true
    errors.push({ field: 'activationEvents', message: `unknown activation event: ${event}` })
    return false
  })

  const permissions = permissionList(r.permissions, 'permissions', errors)
  const optionalPermissions = permissionList(r.optionalPermissions, 'optionalPermissions', errors)

  const hostPermissions = strList(r.hostPermissions).filter((pattern) => {
    if (isHostPattern(pattern)) return true
    errors.push({ field: 'hostPermissions', message: `must look like https://host/path* : ${pattern}` })
    return false
  })
  /*
    ★ 没声明 `net` 却写了 `hostPermissions` 是**警告不是错误**:它通常是
    作者把 `net` 从 `permissions` 挪进 `optionalPermissions` 时留下的,
    拒绝整份清单太重;但不提醒的话,他会发现请求全被拒而找不到原因。
  */
  if (hostPermissions.length > 0 && !permissions.includes('net') && !optionalPermissions.includes('net')) {
    warnings.push({ field: 'hostPermissions', message: 'has no effect without the "net" permission' })
  }

  /*
    ★ 和 `hostPermissions` 对称:那个回答「能连哪些域名」,这个回答
    「能跑哪些可执行文件」。`process` 能力本身只表示「可以跑命令」,
    具体跑什么必须由清单逐条列出 —— 没有这张表就一条都不许跑
    (`capabilities.ts` 的 `narrowCommand`)。

    ★ 存的是**去掉目录和 Windows 可执行后缀之后的 stem**,因为参数门就是
    按 stem 比对的。作者写 `/usr/bin/git` 或 `git.exe` 的话,归一之后
    比对得上、但清单上写着的和实际生效的不是一个东西 —— 与其默默替他改,
    不如在这里就报错,否则他只会看到「命令不在白名单里」而对不上原因。
  */
  const allowedCommands = strList(r.allowedCommands).filter((command) => {
    if (isCommandStem(command)) return true
    errors.push({ field: 'allowedCommands', message: `must be a bare executable name without a path: ${command}` })
    return false
  }).slice(0, MAX_CONTRIBUTIONS_PER_KIND)
  // 同 hostPermissions:声明了却没有对应能力是**警告**,不是整份清单作废。
  if (allowedCommands.length > 0 && !permissions.includes('process') && !optionalPermissions.includes('process')) {
    warnings.push({ field: 'allowedCommands', message: 'has no effect without the "process" permission' })
  }

  const contributes = parseContributes(r.contributes, errors)

  // 依赖:pluginId → 版本 range(同 engines 的 range 语法)。自依赖是错误。
  const dependencies: Record<string, string> = {}
  const depsRaw = r.dependencies
  if (depsRaw !== null && typeof depsRaw === 'object' && !Array.isArray(depsRaw)) {
    for (const [depId, range] of Object.entries(depsRaw as Record<string, unknown>)) {
      const depRange = str(range)
      if (!PLUGIN_ID_RE.test(depId)) {
        errors.push({ field: `dependencies.${depId}`, message: 'not a valid plugin id (publisher.name)' })
        continue
      }
      if (depId === `${publisher}.${name}`) {
        errors.push({ field: `dependencies.${depId}`, message: 'a plugin cannot depend on itself' })
        continue
      }
      if (parseRange(depRange) === null) {
        errors.push({ field: `dependencies.${depId}`, message: `unsupported range: ${depRange}` })
        continue
      }
      dependencies[depId] = depRange
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    warnings,
    manifest: {
      id: `${publisher}.${name}`,
      name,
      publisher,
      displayName,
      description,
      version,
      ...(str(r.license) === '' ? {} : { license: str(r.license) }),
      ...(icon === '' ? {} : { icon }),
      categories: strList(r.categories).slice(0, 8),
      keywords: strList(r.keywords).slice(0, 16),
      engines,
      main,
      ...(l10n === '' ? {} : { l10n }),
      activationEvents,
      permissions,
      optionalPermissions,
      hostPermissions,
      allowedCommands,
      dependencies,
      contributes
    }
  }
}

// ─────────────────────────── 贡献点 ───────────────────────────

/** 这一版实现了的 `contributes` 键。不在表里的进 `unsupported`,报诊断。 */
export const SUPPORTED_CONTRIBUTION_KEYS = [
  'commands',
  'menus',
  'customEditors',
  'views',
  'tools',
  'cardViews',
  'keybindings',
  'skills',
  'themes',
  'configuration'
] as const

/**
 * 工具卡片模板 `{ title?, summary? }` 的解析。
 *
 * 返回 `'error'` 表示已推诊断、调用方应跳过这条工具;`undefined` 表示没声明卡片模板。
 * title/summary 若存在必须是 `%l10nKey%`(与工具 title 同规则)。
 */
function parseToolCard(
  raw: unknown,
  toolName: string,
  errors: ManifestError[]
): { title?: string; summary?: string } | undefined | 'error' {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const c = raw as Record<string, unknown>
  const title = str(c.title)
  const summary = str(c.summary)
  if (title !== '' && !L10N_REF_RE.test(title)) {
    errors.push({ field: `contributes.tools.${toolName}.card.title`, message: 'must be a %l10nKey% reference' })
    return 'error'
  }
  if (summary !== '' && !L10N_REF_RE.test(summary)) {
    errors.push({ field: `contributes.tools.${toolName}.card.summary`, message: 'must be a %l10nKey% reference' })
    return 'error'
  }
  if (title === '' && summary === '') return undefined
  return { ...(title === '' ? {} : { title }), ...(summary === '' ? {} : { summary }) }
}

function parseContributes(raw: unknown, errors: ManifestError[]): PluginContributes {
  const out: PluginContributes = {
    commands: [],
    menus: {},
    customEditors: [],
    views: [],
    tools: [],
    cardViews: [],
    keybindings: [],
    skills: [],
    themes: [],
    unsupported: []
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>

  for (const key of Object.keys(r)) {
    if (!(SUPPORTED_CONTRIBUTION_KEYS as readonly string[]).includes(key)) out.unsupported.push(key)
  }

  for (const item of objList(r.commands)) {
    const command = str(item.command)
    const title = str(item.title)
    if (command === '') { errors.push({ field: 'contributes.commands', message: 'command id is required' }); continue }
    if (!L10N_REF_RE.test(title)) { errors.push({ field: `contributes.commands.${command}.title`, message: 'must be a %l10nKey% reference, not literal copy' }); continue }
    out.commands.push({ command, title, ...(str(item.icon) === '' ? {} : { icon: str(item.icon) }) })
  }

  const menus = r.menus
  if (menus !== null && typeof menus === 'object' && !Array.isArray(menus)) {
    for (const [menuId, value] of Object.entries(menus as Record<string, unknown>)) {
      const items: PluginMenuContribution[] = []
      for (const item of objList(value)) {
        const command = str(item.command)
        if (command === '') continue
        items.push({
          command,
          ...(str(item.group) === '' ? {} : { group: str(item.group) }),
          ...(str(item.when) === '' ? {} : { when: str(item.when) })
        })
      }
      if (items.length > 0) out.menus[menuId] = items.slice(0, MAX_CONTRIBUTIONS_PER_KIND)
    }
  }

  for (const item of objList(r.customEditors)) {
    const viewType = str(item.viewType)
    const displayName = str(item.displayName)
    if (viewType === '') { errors.push({ field: 'contributes.customEditors', message: 'viewType is required' }); continue }
    if (!L10N_REF_RE.test(displayName)) { errors.push({ field: `contributes.customEditors.${viewType}.displayName`, message: 'must be a %l10nKey% reference' }); continue }
    const selector = objList(item.selector)
      .map((s) => str(s.filenamePattern))
      .filter((pattern) => pattern !== '')
      .map((filenamePattern) => ({ filenamePattern }))
    if (selector.length === 0) { errors.push({ field: `contributes.customEditors.${viewType}.selector`, message: 'needs at least one filenamePattern' }); continue }
    const priority = str(item.priority)
    out.customEditors.push({
      viewType,
      displayName,
      selector,
      ...(priority === 'option' ? { priority: 'option' as const } : { priority: 'default' as const })
    })
  }

  for (const item of objList(r.views)) {
    const id = str(item.id)
    const title = str(item.title)
    const path = str(item.path)
    if (id === '') { errors.push({ field: 'contributes.views', message: 'view id is required' }); continue }
    if (!L10N_REF_RE.test(title)) { errors.push({ field: `contributes.views.${id}.title`, message: 'must be a %l10nKey% reference' }); continue }
    if (!isSafeRelativePath(path)) { errors.push({ field: `contributes.views.${id}.path`, message: 'must be a relative path inside the package' }); continue }
    out.views.push({ id, title, path, ...(str(item.icon) === '' ? {} : { icon: str(item.icon) }) })
  }

  for (const item of objList(r.tools)) {
    const name = str(item.name)
    const title = str(item.title)
    if (name === '') { errors.push({ field: 'contributes.tools', message: 'tool name is required' }); continue }
    if (!L10N_REF_RE.test(title)) { errors.push({ field: `contributes.tools.${name}.title`, message: 'must be a %l10nKey% reference' }); continue }
    const shape = str(item.shape)
    if (shape !== '' && !(TOOL_SHAPES as readonly string[]).includes(shape)) {
      errors.push({ field: `contributes.tools.${name}.shape`, message: `unknown shape: ${shape}` }); continue
    }
    const card = parseToolCard(item.card, name, errors)
    if (card === 'error') continue
    out.tools.push({
      name,
      title,
      ...(str(item.icon) === '' ? {} : { icon: str(item.icon) }),
      ...(shape === '' ? {} : { shape: shape as PluginToolShape }),
      ...(card === undefined ? {} : { card })
    })
  }

  for (const item of objList(r.cardViews)) {
    const viewType = str(item.viewType)
    const path = str(item.path)
    if (viewType === '') { errors.push({ field: 'contributes.cardViews', message: 'viewType is required' }); continue }
    if (!isSafeRelativePath(path)) { errors.push({ field: `contributes.cardViews.${viewType}.path`, message: 'must be a relative path inside the package' }); continue }
    out.cardViews.push({ viewType, path })
  }

  for (const item of objList(r.keybindings)) {
    const command = str(item.command)
    const key = str(item.key)
    if (command === '' || key === '') continue
    out.keybindings.push({ command, key, ...(str(item.when) === '' ? {} : { when: str(item.when) }) })
  }

  for (const item of objList(r.skills)) {
    const path = str(item.path)
    if (isSafeRelativePath(path)) out.skills.push({ path })
    else errors.push({ field: 'contributes.skills', message: `not a package-relative path: ${path}` })
  }

  for (const item of objList(r.themes)) {
    const path = str(item.path)
    if (isSafeRelativePath(path)) out.themes.push({ path })
    else errors.push({ field: 'contributes.themes', message: `not a package-relative path: ${path}` })
  }

  const configuration = r.configuration
  if (configuration !== null && typeof configuration === 'object' && !Array.isArray(configuration)) {
    const c = configuration as Record<string, unknown>
    const title = str(c.title)
    if (!L10N_REF_RE.test(title)) {
      errors.push({ field: 'contributes.configuration.title', message: 'must be a %l10nKey% reference' })
    } else {
      const properties: Record<string, PluginConfigurationProperty> = {}
      const rawProps = c.properties
      if (rawProps !== null && typeof rawProps === 'object' && !Array.isArray(rawProps)) {
        for (const [key, value] of Object.entries(rawProps as Record<string, unknown>)) {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
          const v = value as Record<string, unknown>
          const type = str(v.type)
          const propTitle = str(v.title)
          if (!['boolean', 'string', 'number', 'enum'].includes(type)) continue
          if (!L10N_REF_RE.test(propTitle)) {
            errors.push({ field: `contributes.configuration.properties.${key}.title`, message: 'must be a %l10nKey% reference' })
            continue
          }
          properties[key] = {
            type: type as PluginConfigurationProperty['type'],
            title: propTitle,
            ...(v.default === undefined ? {} : { default: v.default as boolean | string | number }),
            ...(Array.isArray(v.enum) ? { enum: strList(v.enum) } : {})
          }
        }
      }
      out.configuration = { title, properties }
    }
  }

  return out
}

// ─────────────────────────── 版本范围 ───────────────────────────

export interface SemVer { major: number; minor: number; patch: number }

export function parseSemVer(value: string): SemVer | null {
  const m = PLUGIN_VERSION_RE.exec(value)
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

interface Range { op: '^' | '~' | '>=' | '='; version: SemVer }

/**
 * 只认四种形状:`^x.y.z` / `~x.y.z` / `>=x.y.z` / `x.y.z`。
 *
 * ★ **刻意不支持复合 range**(`>=1.0 <2.0`、`||`)。range 语法是 npm
 * 生态里最容易写错、也最难向用户解释的一块;而插件真正需要表达的只有
 * 「我要这个大版本」。认不出来的一律拒绝上架,比装上之后行为不可预测好。
 */
export function parseRange(value: string): Range | null {
  const trimmed = value.trim()
  for (const op of ['>=', '^', '~'] as const) {
    if (trimmed.startsWith(op)) {
      const version = parseSemVer(trimmed.slice(op.length).trim())
      return version === null ? null : { op, version }
    }
  }
  const version = parseSemVer(trimmed)
  return version === null ? null : { op: '=', version }
}

function compare(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** 宿主版本满足这个 range 吗。range 读不懂时返回 `false`(不是 true)。 */
export function satisfiesEngine(range: string, hostVersion: string): boolean {
  const parsed = parseRange(range)
  const host = parseSemVer(hostVersion)
  if (parsed === null || host === null) return false
  const { op, version } = parsed
  if (op === '=') return compare(host, version) === 0
  if (op === '>=') return compare(host, version) >= 0
  if (compare(host, version) < 0) return false
  if (op === '^') {
    /*
      0.x 的 `^` 按 npm 的规矩只锁到 minor —— 而插件 API 在 1.0 之前
      明确可以 break,这条正好是我们要的语义。
    */
    return version.major === 0 ? host.major === 0 && host.minor === version.minor : host.major === version.major
  }
  return host.major === version.major && host.minor === version.minor
}

/**
 * 市场那一版比本机这一版新吗 —— 「要不要提示更新」的唯一判据。
 *
 * ★ 导出的是**谓词**而不是 `compare`:调用点关心的是「有没有更新」,不是
 * 「差几个数」。让它们自己去拼 `parseSemVer` + 比较,等于把下面这条
 * 预发布规则复制 N 份,而它一定会被漏掉其中一份。
 *
 * ★★ **`parseSemVer` 是丢预发布标签的**(它只取 x.y.z),而 `PLUGIN_VERSION_RE`
 * 接受 `-beta.1`。于是本机 `1.0.0-beta` 和市场 `1.0.0` 比出来相等 —— 而那
 * 恰恰是最该提示更新的一种情况:用户手上拿的是个预览版。核心版本相等时
 * 单独补一条:本机带预发布、市场不带 = 有更新。
 *
 * ★ 读不懂的版本号返回 `false`(不是 true),同 `satisfiesEngine` 的规矩 ——
 * 宁可不提示,也不要提示一次点下去必然失败的更新。
 */
export function hasNewerVersion(current: string, latest: string | null | undefined): boolean {
  if (typeof latest !== 'string') return false
  const mine = parseSemVer(current)
  const theirs = parseSemVer(latest)
  if (mine === null || theirs === null) return false
  const diff = compare(theirs, mine)
  if (diff !== 0) return diff > 0
  return current.includes('-') && !latest.includes('-')
}

// ─────────────────────────── 小工具 ───────────────────────────

export function isActivationEvent(event: string): boolean {
  if ((ACTIVATION_EVENT_LITERALS as readonly string[]).includes(event)) return true
  return ACTIVATION_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix) && event.length > prefix.length)
}

/**
 * 包内相对路径。
 *
 * ★ 挡的不只是 `..`:绝对路径、盘符、反斜杠、URL scheme 全在这里挡掉。
 * 这条是**第一道**防线,主进程侧还会再做一次 realpath 归一
 * (软链是这一层看不出来的)。
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.length > 512) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(value)) return false
  if (value.includes('\\')) return false
  if (value.includes('\0')) return false
  return !value.split('/').some((segment) => segment === '..')
}

/** `https://host/path*`。★ 不接受 `http:`,不接受 `*` 当主机名。 */
export function isHostPattern(value: string): boolean {
  if (!value.startsWith('https://')) return false
  const rest = value.slice('https://'.length)
  const host = rest.split('/')[0] ?? ''
  if (host === '' || host === '*' || host.includes('*')) return false
  return /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)
}

/**
 * `allowedCommands` 的一条合法取值 —— **裸可执行名**。
 *
 * ★ 拒绝路径分隔符和 `.exe`/`.cmd`/`.bat`/`.ps1` 后缀,而不是把它们剥掉:
 * 参数门(`capabilities.ts` 的 `narrowCommand`)比对的是归一之后的 stem,
 * 默默替作者剥掉的话,清单上写着的和实际生效的就成了两个东西。
 */
export function isCommandStem(value: string): boolean {
  if (value === '' || value.length > 64) return false
  if (/[/\\]/.test(value)) return false
  if (/\.(exe|cmd|bat|ps1)$/i.test(value)) return false
  return /^[a-z0-9._+-]+$/i.test(value)
}

/** 一个具体 URL 命中 `hostPermissions` 里的某一条吗。 */
export function matchesHostPermission(patterns: readonly string[], url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  return patterns.some((pattern) => {
    if (!isHostPattern(pattern)) return false
    const rest = pattern.slice('https://'.length)
    const slash = rest.indexOf('/')
    const host = slash === -1 ? rest : rest.slice(0, slash)
    const path = slash === -1 ? '/*' : rest.slice(slash)
    if (parsed.host.toLowerCase() !== host.toLowerCase()) return false
    if (path === '/*' || path === '*') return true
    if (path.endsWith('*')) return parsed.pathname.startsWith(path.slice(0, -1))
    return parsed.pathname === path
  })
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    const s = str(entry)
    if (s !== '' && !out.includes(s)) out.push(s)
    if (out.length >= MAX_CONTRIBUTIONS_PER_KIND) break
  }
  return out
}

function objList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    .slice(0, MAX_CONTRIBUTIONS_PER_KIND)
}

function permissionList(raw: unknown, field: string, errors: ManifestError[]): PluginPermission[] {
  const out: PluginPermission[] = []
  for (const entry of strList(raw)) {
    if (isPluginPermission(entry)) {
      if (!out.includes(entry)) out.push(entry)
    } else {
      errors.push({ field, message: `unknown permission "${entry}"; expected one of ${PLUGIN_PERMISSIONS.join(', ')}` })
    }
  }
  return out
}
