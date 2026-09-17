/**
 * 插件市场条目 —— 主进程与渲染层共用的只读投影。
 *
 * ★ 单独一个文件而不是放进 `state.ts`:那边描述的是**装在本机上的**插件
 * (带状态、诊断、授权),这边描述的是**市场上的**条目(带下载量、作者)。
 * 两者只有名字像,字段几乎不重叠 —— 合成一个类型会让「这个字段在哪种场景
 * 下才有值」变成每个调用点都要重新判断的事。
 */

export interface PluginMarketItem {
  /** `publisher.name` —— 和本机已装的那份比对靠它,不是 slug */
  pluginId: string
  slug: string
  publisher: string
  displayName: string
  description: string
  category: string
  iconUrl: string | null
  downloadCount: number
  version: string | null
  /** `^0.2.0` 这类。列表已按它过滤过,留着是为了在详情页说清「要求什么版本」 */
  engines: string | null
  /**
   * 这一版声明的**必选能力**。
   *
   * ★ 列表里就要显示,不能等到点了安装才说。装插件这个决定的全部信息量
   * 就在这一行里 —— 把它藏到下一屏,等于让用户先决定再了解。
   */
  permissions: string[]
  author: string
}
