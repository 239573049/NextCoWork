/**
 * 上游供应商 / 模型别名 —— 目前只有读的两条(写入面见 `main/ipc/provider.ts` 的注释)。
 *
 * 组件不直接碰频道字符串(协议 §9),所以输入框那颗模型选择器调的是这里,
 * 而不是 `invoke('provider:listModels', …)`。
 */
import type { ModelAlias, UpstreamProvider } from '../../../shared/domain/provider'
import { invoke } from './ipc'

export function listProviders(): Promise<UpstreamProvider[]> {
  return invoke('provider:list', undefined)
}

/** 省略 providerId = 全部别名。 */
export function listModels(providerId?: string): Promise<ModelAlias[]> {
  return invoke('provider:listModels', providerId === undefined ? {} : { providerId })
}
