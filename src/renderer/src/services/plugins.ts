/**
 * 插件域的 IPC 封装。
 *
 * ## 为什么现在才有这个文件
 *
 * `stores/plugins.ts` 等处一直直接写频道字符串(AGENTS §1 的已知违规)。
 * 本文件**只收编新增的调用**,不顺手迁移存量 —— 那是一次独立重构,混进
 * 功能改动会把 diff 淹掉。往 `stores/plugins.ts` 加新调用时优先来这里。
 */
import { invoke } from './ipc'

/**
 * 打开自定义编辑器 Tab 之前的唤醒。返回 `false` = 插件没醒成(原因在
 * 插件详情页的诊断里),调用方应留在降级态,不要渲染注定 403 的 iframe。
 */
export function activatePluginEditor(pluginId: string, viewType: string): Promise<{ activated: boolean }> {
  return invoke('plugins:activateEditor', { pluginId, viewType })
}

/**
 * 用户点了侧边栏上某个网页应用的入口。
 *
 * ★ 不在渲染层直接拿 catalog 里的 URL 开 Tab:激活事件(`onWebApp:<id>`)
 * 只有主进程发得出来,而「这个插件此刻能不能用」的判定也只该有一处真源。
 * 见 `main/ipc/plugins.ts` 的 `openPluginWebApp`。
 */
export function openPluginWebApp(pluginId: string, webAppId: string): Promise<void> {
  return invoke('plugins:openWebApp', { pluginId, webAppId })
}

/**
 * 用户回答了插件的那一问(选项 / 输入 / 确认)。
 *
 * ★ **取消也要回**。不回的话,插件那边会一直等到 5 分钟超时 —— 而它可能
 * 正挂在一次工具调用里,用户看到的是「这一轮卡住了」。
 */
export function replyPluginInteraction(requestId: string, value: unknown): Promise<void> {
  return invoke('plugins:interactionReply', { requestId, value })
}

/**
 * 自定义编辑器的脏标记。
 *
 * ★ 宿主的「关 Tab 之前问一句」(`plugins:confirmClose`)完全靠这张表。
 * 不上报的话,插件编辑器里没存的改动会在关 Tab 的那一刻静默消失 ——
 * 而内置文档的挽留一直是有的,两者行为不一致更难被发现。
 */
export function setCustomEditorDirty(
  pluginId: string,
  documentId: string,
  path: string,
  dirty: boolean
): Promise<void> {
  return invoke('plugins:setEditorDirty', { pluginId, documentId, path, dirty })
}
