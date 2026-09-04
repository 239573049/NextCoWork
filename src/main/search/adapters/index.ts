/**
 * 「哪家有适配器」的唯一出处。
 *
 * ★ 是 `Partial<Record<...>>` 而不是全表:豆包和 Bing 在 `SEARCH_CATALOG` 里
 * 标了 `unavailable`,它们**没有适配器,也不该有**(理由在 search.ts 文件头)。
 * 写成全表就得为这两家各造一个「抛异常」的假适配器,而那种占位实现迟早会被
 * 某个人当成「已经接上了,只是有 bug」。
 *
 * `service.ts` 那句 `adapter === undefined → 跳过` 就是这张表的读法。
 */
import type { AdapterTable } from '../types'
import { brave } from './brave'
import { exa } from './exa'
import { metaso } from './metaso'
import { serpapi } from './serpapi'
import { serper } from './serper'
import { tavily } from './tavily'

export const ADAPTERS: AdapterTable = { tavily, exa, brave, serper, serpapi, metaso }
