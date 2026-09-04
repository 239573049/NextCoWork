/**
 * 上游供应商与模型别名的**只读**两条 —— 步骤 4 的写入面(upsert / remove /
 * setCredential / test)仍是 todo。
 *
 * 单独实现这两条,是因为它们是**输入框那颗模型选择器的唯一数据源**:
 * 没有它们,发送行上那颗药丸只能写死一个字符串,而「当前用的是哪个上游、
 * 它支不支持思考」这件事在界面上就永远是假的。
 *
 * 走 `store` 而不是 `getRouter().listModels()`:后者会在别名表之上再叠一层
 * 健康与候选集筛选(方案 §5.3),而下拉框要显示的是**用户配过的全部模型**,
 * 不是「此刻健康的那些」。一个正在冷却的 provider 不该从下拉框里消失 ——
 * 它应该显示出来并标成不可用,否则用户会以为自己的配置丢了。
 *
 * ★ 但 seed 必须先跑。`runtime.getRouter()` 是 seed 的触发点之一,而首屏
 * 拉模型列表时可能还没有任何 run 跑过 —— 于是这里显式调用 `ensureSeeded()`,
 * 否则全新安装点开下拉框是空的,而演示上游明明已经在设置里被指成默认模型了。
 */
import type { ModelAlias, UpstreamProvider } from '../../shared/domain/provider'
import { ensureSeeded } from '../runtime'
import { store } from '../state/store'

export function listProviders(): UpstreamProvider[] {
  ensureSeeded()
  return store.listProviders()
}

/**
 * `providerId` 省略 = 全部别名。
 *
 * 排序照 provider 的 priority(`listProviders` 已经排好),同一 provider 内
 * 保持配置顺序 —— 下拉框的顺序是用户资产,不该按字典序重排成他不认识的样子。
 */
export function listModels(providerId?: string): ModelAlias[] {
  ensureSeeded()
  const rank = new Map(store.listProviders().map((p, i) => [p.id, i]))
  return store
    .listAliases()
    .filter((a) => providerId === undefined || a.providerId === providerId)
    .sort((a, b) => (rank.get(a.providerId) ?? 1e9) - (rank.get(b.providerId) ?? 1e9))
}
