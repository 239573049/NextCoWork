/**
 * 「导入模型」弹窗的判断逻辑。
 *
 * ★ 抽成 `.ts` 是为了能测:`vitest.config.ts` 是 node 环境且只收 `.test.ts`,
 * 留在 `.tsx` 里的话下面这些**全是静默错**的规则一行测试都不会跑。
 */
import {
  MAX_ALIASES_PER_PROVIDER,
  type FetchedModel,
  type ModelAlias,
  type UpstreamProtocol
} from '../../../../../shared/domain/provider'
import { endpointFor, findPreset } from '../../../../../shared/domain/presets'

/** 弹窗里的一行 */
export interface ImportRow {
  id: string
  displayName?: string
  /** 已经在别名表里 —— 默认勾上,并挂「已添加」角标 */
  added: boolean
  /** 上游这次的列表里有它。false = **只在本地有** */
  fromUpstream: boolean
}

/**
 * 拉回来的列表 + 已配好的别名 → 弹窗要显示的行。
 *
 * ★★ **本地有、上游这次没报的那些必须也列出来,这是参考图没有的一行。**
 * 弹窗的语义是「替换」(取消勾选 = 删掉),所以只显示上游报回来的那些的话,
 * 一个用户手工配过、而 `/models` 恰好没列出的别名会在他点「更新列表」时
 * **被连带删掉,且他从头到尾没在弹窗里见过它**。
 *
 * 这不是假想:模型列表端点各家给的全集都不一样(有的只给通用模型、不给
 * 微调和预览版),而免鉴权拉到的那份通常比带 key 拉到的更窄。
 *
 * 所以它们排在末尾、默认勾上、角标和上游来的那些不同 —— 看得见,也删得掉,
 * 但不会**替他**删。
 */
export function importRows(
  fetched: readonly FetchedModel[],
  aliases: readonly ModelAlias[]
): ImportRow[] {
  const added = addedModels(aliases)
  const seen = new Set<string>()
  const rows: ImportRow[] = []

  for (const m of fetched) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    rows.push({
      id: m.id,
      ...(m.displayName === undefined ? {} : { displayName: m.displayName }),
      added: added.has(m.id),
      fromUpstream: true
    })
  }
  for (const m of added) {
    if (seen.has(m)) continue
    seen.add(m)
    rows.push({ id: m, added: true, fromUpstream: false })
  }
  return rows
}

/** 别名表里这家已经配了哪些**上游模型名**(不是别名 —— 别名可能被改过) */
export function addedModels(aliases: readonly ModelAlias[]): Set<string> {
  return new Set(aliases.map((a) => a.upstreamModel))
}

/**
 * 打开弹窗时默认勾哪些 —— 参考图原话「已添加模型会默认勾选」。
 *
 * ★ 超过上限时**只勾前 20 个**,而不是勾满全部再让「更新列表」按钮报错。
 * (上限是后来加的,库里可能已经有更多条;那时候按钮点不动、又说不清为什么,
 * 比少勾几个糟得多。)
 */
export function initialSelection(rows: readonly ImportRow[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (!r.added) continue
    if (out.size >= MAX_ALIASES_PER_PROVIDER) break
    out.add(r.id)
  }
  return out
}

/** 搜索框:按模型 id 和显示名过滤,大小写不敏感。空查询 = 全部 */
export function filterRows(rows: readonly ImportRow[], query: string): ImportRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...rows]
  return rows.filter(
    (r) => r.id.toLowerCase().includes(q) || (r.displayName ?? '').toLowerCase().includes(q)
  )
}

/**
 * 勾 / 取消勾一条。
 *
 * `atCap` = 这次**没勾上**,因为已经到上限了。调用点据此提示,
 * 而不是让复选框点下去毫无反应 —— 那看着就是个 bug。
 */
export function toggleRow(
  selected: ReadonlySet<string>,
  id: string
): { selected: Set<string>; atCap: boolean } {
  const next = new Set(selected)
  if (next.delete(id)) return { selected: next, atCap: false }
  if (next.size >= MAX_ALIASES_PER_PROVIDER) return { selected: next, atCap: true }
  next.add(id)
  return { selected: next, atCap: false }
}

/**
 * 「全选」。作用域是**当前筛出来的那些**,不是全表 ——
 * 用户搜了 "gpt" 之后点全选,想选的是这些 gpt,不是把 300 个全勾上。
 *
 * 可见的都已勾上 → 变成取消全选。`truncated` = 撞了上限没勾满。
 */
export function toggleAll(
  selected: ReadonlySet<string>,
  visible: readonly ImportRow[]
): { selected: Set<string>; truncated: boolean } {
  const next = new Set(selected)
  if (visible.length > 0 && visible.every((r) => next.has(r.id))) {
    for (const r of visible) next.delete(r.id)
    return { selected: next, truncated: false }
  }
  let truncated = false
  for (const r of visible) {
    if (next.has(r.id)) continue
    if (next.size >= MAX_ALIASES_PER_PROVIDER) {
      truncated = true
      break
    }
    next.add(r.id)
  }
  return { selected: next, truncated }
}

/** 提交给 `provider:setAliases` 的顺序 —— 照弹窗里的显示顺序,不按勾选先后 */
export function submitOrder(rows: readonly ImportRow[], selected: ReadonlySet<string>): string[] {
  return rows.filter((r) => selected.has(r.id)).map((r) => r.id)
}

/**
 * 这家能不能拉模型列表。
 *
 * ★★ **`supportsModelList: false` 只在地址没被改过时才置灰。**
 * 那个标记是我们某一天实测到的形状。用户把地址换成自己的中转之后,这张快照
 * 描述的就不再是他的端点了 —— 照它置灰等于让一个明明能用的端点永远拉不了,
 * 而且没有任何绕过办法。这和表单里 Responses 开关那条是同一个判断
 * (`ProviderPanel.tsx`:提示而不是禁掉)。
 *
 * ★ 预设里查不到这家(用户自建的)= **未知,不是不支持** —— 一律放行。
 */
export function modelListAvailability(p: {
  id: string
  protocol: UpstreamProtocol
  baseUrl: string
}): { enabled: boolean; hint: string | null; needsKey: boolean } {
  const preset = findPreset(p.id)
  const endpoint = preset === null ? null : endpointFor(preset, p.protocol)
  if (endpoint === null) return { enabled: true, hint: null, needsKey: true }

  const needsKey = endpoint.modelListPublic !== true
  if (endpoint.supportsModelList) {
    return {
      enabled: true,
      hint: needsKey ? null : '这家免鉴权就能拉列表,密钥还没填也可以先看看有哪些模型。',
      needsKey
    }
  }
  if (p.baseUrl.replace(/\/+$/, '') === endpoint.baseUrl.replace(/\/+$/, '')) {
    return {
      enabled: false,
      hint: '我们实测这家的这个端点没有模型列表,只能手动填模型名。',
      needsKey
    }
  }
  return {
    enabled: true,
    hint: '预设里这家没有模型列表端点,但你改过地址 —— 可以试一下。',
    needsKey
  }
}
