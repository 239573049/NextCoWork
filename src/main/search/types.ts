/**
 * 适配器的形状 —— 六家的差异全部压在这一个函数签名后面。
 *
 * ★ **HTTP 一律走 `deps.fetch`**(即 `KernelHost.fetch`),不 import 全局 fetch。
 * 两个后果都是要的:Electron 侧那个是 `net.fetch`(于是 Phase 4 的代理对搜索
 * 天然生效),而测试侧可以塞一个假的进来,不必真的联网。
 */
import type { SearchProviderId, SearchResult } from '../../shared/domain/search'

export interface AdapterDeps {
  fetch: typeof fetch
  signal: AbortSignal
}

export interface AdapterInput {
  query: string
  /** 想要几条。各家的参数名不同,适配器自己翻译;拿回来多了由上层截断 */
  count: number
}

/**
 * 一家搜索服务。
 *
 * ★ **失败就抛**,不返回空数组。上层(`service.ts`)靠异常和空结果区分
 * 「这家坏了,换下一家」与「这家好好的,就是没搜到」—— 两者对用户的意义
 * 完全不同:前者该切换,后者该如实告诉模型「没搜到」,再切一遍只是浪费时间和额度。
 */
export type SearchAdapter = (
  input: AdapterInput,
  apiKey: string,
  deps: AdapterDeps
) => Promise<SearchResult[]>

export type AdapterTable = Partial<Record<SearchProviderId, SearchAdapter>>
