/**
 * 设置 handler。
 *
 * 变更后**主动广播** settings:changed —— 多窗口下,在快捷窗改了主题,
 * 主窗必须跟着变。这是 GlobalEventChannel 的正当用法(与 agent:event 那种
 * 必须按订阅定向推送的相对)。
 */
import type { AppSettings, AppSettingsPatch } from '../../shared/domain/settings'
import { store } from '../state/store'
import { windows } from '../window/registry'
import { applyThemePreference } from './app'

export function getSettings(): AppSettings {
  return store.getSettings()
}

export function updateSettings(patch: AppSettingsPatch): AppSettings {
  const before = store.getSettings()
  const next = store.updateSettings(patch)

  if (patch.theme !== undefined && patch.theme !== before.theme) {
    const resolved = applyThemePreference(next.theme)
    windows.emitToAll('theme:changed', { resolved })
  }

  windows.emitToAll('settings:changed', next)
  return next
}
