/**
 * 插件活动日志 —— 环形缓冲,照抄 `main/hooks.ts` 的 `recentFailures`。
 *
 * ## 为什么每一次 facade 调用都要记一条
 *
 * 插件系统最难回答的问题不是「它能干什么」(清单里写着),而是
 * **「它刚才干了什么」**。没有这份日志,一个读文件读得过于勤快的插件和一个
 * 完全没在跑的插件,在界面上长得一模一样。
 *
 * ## 记什么、不记什么
 *
 * - 记:时间、插件、方法、**人话摘要**、裁决、耗时。
 * - **不记参数原文**。`workspace.writeFile` 的参数里是整个文件内容,
 *   `net.fetch` 的参数里可能有 token。摘要由各能力自己给,只放路径/域名
 *   这类「够用来认出是哪一次」的信息。
 */
import type { PluginActivity } from '../../shared/plugin/state'

/** 留多少条。超过就丢最老的 —— 这是诊断面板,不是审计存档。 */
const MAX_ACTIVITY = 500

const ring: PluginActivity[] = []

export function recordActivity(entry: PluginActivity): void {
  ring.push(entry)
  if (ring.length > MAX_ACTIVITY) ring.splice(0, ring.length - MAX_ACTIVITY)
}

/** 最近的在前 —— 面板从上往下读,最近发生的那条应该第一眼看见。 */
export function recentActivity(pluginId?: string): PluginActivity[] {
  const all = pluginId === undefined ? ring : ring.filter((entry) => entry.pluginId === pluginId)
  return [...all].reverse()
}

/** 卸载插件时把它的记录一起清掉 —— 卸了之后还留着别人的历史是误导。 */
export function clearActivity(pluginId: string): void {
  for (let i = ring.length - 1; i >= 0; i -= 1) {
    if (ring[i]?.pluginId === pluginId) ring.splice(i, 1)
  }
}

export function clearAllActivity(): void {
  ring.length = 0
}
