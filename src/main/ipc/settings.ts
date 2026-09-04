/**
 * 设置 handler。
 *
 * 变更后**主动广播** settings:changed —— 多窗口下,在快捷窗改了主题,
 * 主窗必须跟着变。这是 GlobalEventChannel 的正当用法(与 agent:event 那种
 * 必须按订阅定向推送的相对)。
 */
import type { AppSettings, AppSettingsPatch } from '../../shared/domain/settings'
import { applyProxy } from '../net/proxy'
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

  /*
    ★ 代理要**在广播之前**推给 Chromium,而且是无条件推(只要 patch 碰了 proxy)。
    不比对 before/after:`AppSettingsPatch` 是深合并的,「变没变」要逐字段比,
    而漏比一个字段的症状是「我改了白名单,它没生效」—— 比多推一次 setProxy
    昂贵得多。setProxy 本身是幂等的。
  */
  if (patch.proxy !== undefined) {
    void applyProxy(next.proxy)
  }

  windows.emitToAll('settings:changed', next)
  return next
}
