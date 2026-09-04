/**
 * 代理密码 —— 只有这三条。
 *
 * ★ 代理的其余字段走 `settings:update`,**只有密码另开频道**:`AppSettings`
 * 会被 `settings:get` 整个读回渲染层,密码进了那个类型就等于每次打开设置页
 * 都往渲染进程送一次明文(见 contract.ts 里 `proxy:*` 那段)。
 *
 * 回程没有 `last4`,也没有任何读回明文的路径 —— 界面只知道「有没有」。
 */
import type { ProxyPasswordInfo } from '../../../shared/domain/proxy'
import { invoke } from './ipc'

export function setProxyPassword(password: string): Promise<ProxyPasswordInfo> {
  return invoke('proxy:setPassword', { password })
}

export function clearProxyPassword(): Promise<ProxyPasswordInfo> {
  return invoke('proxy:clearPassword', undefined)
}

export function getProxyPasswordInfo(): Promise<ProxyPasswordInfo> {
  return invoke('proxy:getPasswordInfo', undefined)
}
