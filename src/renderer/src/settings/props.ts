import type { AppSettings, AppSettingsPatch } from '../../../shared/domain/settings'

/**
 * 每个设置页收到的东西。
 *
 * ★ `settings` 是 prop,**不在页面里 useState 一份镜像**:`App.tsx` 已经是唯一
 * 权威(bootstrap 填一次,`settings:changed` 广播覆盖),而主进程对**所有**窗口
 * 广播、包括发起写入的那个,所以一次 `patch()` 自动回环成一次 setState。
 * 加一层乐观副本会把 `Composer.tsx` 注释里记过的那个 bug 重新引进来
 * (「药丸点下去闪一下又弹回原样」)。
 *
 * ★ `patch` 里的嵌套块**只给要改的那个属性**,别自己 `{ ...settings.gateway, x }` ——
 * 见 `shared/domain/settings.ts` 的 `AppSettingsPatch`。
 */
export interface SettingsPageProps {
  settings: AppSettings
  /** 当前子 Tab 的 id;没有子 Tab 的页面收到空串 */
  sub: string
  patch: (p: AppSettingsPatch) => void
}
