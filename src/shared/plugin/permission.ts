/**
 * 插件能力枚举与授权状态 —— **纯数据,无 IO**,主进程与渲染层共用同一份判断。
 *
 * ## 这里的一条铁律
 *
 * `request()` 只能要 `permissions ∪ optionalPermissions` 之内的东西,之外的
 * **直接拒绝、不弹窗**。这条不是防御性编程,它是整个模型成立的前提:
 *
 * - 市场审核看到的是清单里那两个数组;
 * - 用户安装时看到的也是那两个数组;
 * - 如果运行期还能要到数组之外的能力,那两次「看到」就都成了摆设 ——
 *   一次静默的自动更新就能把一个只读插件变成能跑命令的插件。
 *
 * 所以「清单里的能力上界」= 「运行期可获得的能力上界」,由 `canRequest` 保证。
 *
 * ## 为什么没有 `*` / `all_urls`
 *
 * 通配能力的问题不在于它给得多,而在于**用户无法据此判断风险**:
 * 「访问你的所有数据」这句话在任何一个插件上都长得一样。逐条声明的清单
 * 至少能让「这个画图插件为什么要跑命令」变成一个看得见的问题。
 */

/**
 * 能力全表。每一项对应 `main/plugin/capabilities.ts` 里一条**参数门**,
 * 以及(写类)一条**既有权限链**上的入口。
 */
export const PLUGIN_PERMISSIONS = [
  /** 读工作区文件。限工作区根内,过 `path-guard` 的 realpath 归一。 */
  'workspace.read',
  /** 写工作区文件。走完整的八层权限链,和模型自己写文件同一条路。 */
  'workspace.write',
  /** 跑非交互命令。argv[0] 必须命中清单里的白名单,`destructive: true`。 */
  'process',
  /** 出网。逐 URL 匹配 `hostPermissions`,且受应用的联网总开关管辖。 */
  'net',
  /** 加密的键值存储。key 强制前缀 `plugin:<id>:`。 */
  'secrets',
  /** 普通键值存储,单插件配额 5MB。 */
  'storage',
  /** 读 git 状态 / diff / log。 */
  'scm.read',
  /** commit / branch 一类的写操作,走权限链。 */
  'scm.write',
  /** 注册工具拦截器。★ 只能收紧,不能放宽。 */
  'agent.intercept',
  /** 注入本轮上下文。有长度上限、强制包裹、UI 可见。 */
  'agent.context',
  /** 剪贴板读写。读需要一次性确认。 */
  'clipboard',
  /** 系统通知。有频率限流。 */
  'window.notify',
  /**
   * 与其它插件通信(第 5 层):`connect(dep)` 调它们导出的 API、以及事件总线。
   *
   * ★ 能连谁**另有一道门**:目标必须在本插件清单 `dependencies` 里声明过。
   * 这条能力是给用户看的「这个插件会和别的插件打交道」,`exposeApi`(自己对外
   * 提供 API)不需要它 —— 提供不是消费。
   */
  'plugins'
] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PLUGIN_PERMISSIONS)

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && PERMISSION_SET.has(value)
}

/**
 * 一个插件此刻的授权状态。
 *
 * `required` / `optional` 来自**清单**(装的时候定死,升级时重新比对),
 * `granted` 来自**用户**(装的时候勾的 + 运行期批的)。三者分开存,是因为
 * 「清单要什么」和「用户给了什么」必须能各自回答 —— 合成一个数组之后,
 * 升级时就没法回答「这次新增了哪几条」。
 */
export interface PluginPermissionState {
  readonly required: readonly PluginPermission[]
  readonly optional: readonly PluginPermission[]
  readonly granted: readonly PluginPermission[]
}

export function emptyPermissionState(): PluginPermissionState {
  return { required: [], optional: [], granted: [] }
}

/** 清单允许这个插件**最多**拿到哪些。运行期一切授予都不得越过这条线。 */
export function permissionCeiling(state: PluginPermissionState): Set<PluginPermission> {
  return new Set([...state.required, ...state.optional])
}

/**
 * ★ 铁律的实现:要的东西必须在清单的上界之内。
 *
 * 越界时**不弹窗**。弹了就意味着用户有机会点「允许」,而那一刻他看到的
 * 授权界面和市场里那份清单已经对不上了。
 */
export function canRequest(
  state: PluginPermissionState,
  permissions: readonly PluginPermission[]
): boolean {
  const ceiling = permissionCeiling(state)
  return permissions.every((p) => ceiling.has(p))
}

/** 已经批了吗。`every` 而不是 `some` —— 一次要多条时缺一条就是没有。 */
export function hasPermission(
  state: PluginPermissionState,
  permissions: PluginPermission | readonly PluginPermission[]
): boolean {
  const want = Array.isArray(permissions) ? permissions : [permissions as PluginPermission]
  const granted = new Set(state.granted)
  return want.every((p) => granted.has(p))
}

/** 授予。越过上界的那些**静默丢弃**,不抛 —— 调用方已经先过 `canRequest` 了。 */
export function grantPermissions(
  state: PluginPermissionState,
  permissions: readonly PluginPermission[]
): PluginPermissionState {
  const ceiling = permissionCeiling(state)
  const granted = new Set(state.granted)
  for (const p of permissions) if (ceiling.has(p)) granted.add(p)
  return { ...state, granted: sortPermissions([...granted]) }
}

export function revokePermissions(
  state: PluginPermissionState,
  permissions: readonly PluginPermission[]
): PluginPermissionState {
  const drop = new Set(permissions)
  return { ...state, granted: state.granted.filter((p) => !drop.has(p)) }
}

/**
 * 升级时的**扩权判定**:新版本的必选能力里有旧版本没有的。
 *
 * ★ 只看 `required`(必选)。`optional` 变大不构成扩权 —— 它仍然要用户在
 * 运行期点一次头,而必选是「不批就不激活」,装上就等于给了。
 *
 * 判定为真时插件进入 `disabled-pending-approval`:**用户不批不激活**。
 * 这条堵的是「装完之后自动更新悄悄扩权」那条路。
 */
export function permissionEscalated(
  previous: readonly PluginPermission[],
  next: readonly PluginPermission[]
): boolean {
  const had = new Set(previous)
  return next.some((p) => !had.has(p))
}

/** 新增了哪几条 —— 授权界面要逐条列出来,而不是只说「权限有变化」。 */
export function addedPermissions(
  previous: readonly PluginPermission[],
  next: readonly PluginPermission[]
): PluginPermission[] {
  const had = new Set(previous)
  return next.filter((p) => !had.has(p))
}

/**
 * 按枚举里的书写顺序排。
 *
 * 排序本身是**必需**的,不是整洁癖:这个顺序会原样变成授权弹窗里那几行的顺序,
 * 而 `Set` 的迭代顺序取决于插入顺序 —— 同一个插件装两次、勾选顺序不同,
 * 弹窗里的条目就会换位置,用户没法靠肌肉记忆确认自己批的是同一份东西。
 */
export function sortPermissions(permissions: readonly PluginPermission[]): PluginPermission[] {
  const order = new Map(PLUGIN_PERMISSIONS.map((p, index) => [p, index]))
  return [...permissions].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}

/**
 * 这一条能力是不是「写类」—— 也就是必须过既有权限链、会弹审批的那一类。
 *
 * 读类的在 `evaluate()` 里直接 allow(和内置只读工具同一条路),
 * 写类的和用户手敲一条命令、和 MCP 工具走**完全同一条**审批链。
 */
export function isMutatingPermission(permission: PluginPermission): boolean {
  return permission === 'workspace.write' || permission === 'process' || permission === 'scm.write'
}
