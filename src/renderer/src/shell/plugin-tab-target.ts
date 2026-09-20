/**
 * 插件请求开一个 Tab 时,**开在哪一格**。
 *
 * ## 为什么是一个独立的纯逻辑文件
 *
 * 这段判断要被两个地方用(插件自己调 `tabs.openWebApp` 的广播、用户点侧边栏
 * 入口的广播),而它唯一需要的输入是一条报文加「当前哪个工作区」。写进
 * `AppShell.tsx` 的话,它就只能靠起一个 Electron 才测得到 —— 而这正是
 * AGENTS.md §9/§11 第 4 问要躲开的那种情况。
 *
 * ## 这里**不做安全判断**
 *
 * 能走到这一步说明主进程已经核过了:webapp/view 必须是该插件清单里声明过的,
 * browser 的地址必须命中 `hostPermissions`(见 `main/plugin/manager.ts`)。
 * 这一层只回答「放哪儿、叫什么名字」。
 */
import type { PluginTabTarget } from '../../../shared/plugin/ui-request'
import type { InnerTabKind, TabPane } from '../../../shared/domain/tab'

export interface PluginTabPlacement {
  kind: InnerTabKind
  pane: TabPane
  init: {
    title?: string
    url?: string
    pluginId?: string
    webAppId?: string
    path?: string
    viewType?: string
  }
  /**
   * 这一次有没有被降级过 —— 调用方据此决定要不要提示。
   *
   * ★ 存在的理由是 `open: 'feature'`(独立外层 Tab)**这一版还没实现**:
   * 外层 Tab 条那条 if-else 链、窗口 store、FeatureFrame 三处都要改,
   * 而同一个网页应用作为内层 Tab 已经完全可用。降级本身可以接受,
   * **不告诉任何人**不行 —— 那就是「我明明写了 feature」的静默失效。
   */
  degradedFrom?: 'feature'
}

/**
 * 一条 `plugins:openTab` 报文 → 一次开 Tab 的参数。
 *
 * `title` 给的是**已经翻译好的**文案(调用方用 `t()` 渲染 `plugin.<id>.<key>`),
 * 因为 Tab 标题会跟着布局一起落盘,而落盘的必须是人能读的字。
 */
export function placePluginTab(
  target: PluginTabTarget,
  pluginId: string,
  title: string
): PluginTabPlacement {
  const pane: TabPane = openOf(target) === 'right' ? 'right' : 'main'
  const degraded = openOf(target) === 'feature' ? ({ degradedFrom: 'feature' } as const) : {}
  if (target.kind === 'webapp') {
    return {
      kind: 'webapp',
      pane,
      init: { title, url: target.url, pluginId, webAppId: target.webAppId },
      ...degraded
    }
  }
  /*
    ★ 动态地址开的是**用户的浏览器 Tab**(`kind: 'browser'`),不是 webapp Tab:
    它没有清单背书,用户应当看得见地址栏、能自己导航走。
    webapp 反过来是「插件的一块界面」,地址由清单写死、导航受限。
  */
  return { kind: 'browser', pane, init: { title, url: target.url }, ...degraded }
}

function openOf(target: PluginTabTarget): 'tab' | 'feature' | 'right' {
  return target.open
}
