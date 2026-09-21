/**
 * 闸门的放行判据:什么时候可以挂 `<App/>`。
 *
 * 需求:App 一挂上就会 invoke `app:getBootstrap`,而主进程那边 handler 还没登记完的话,
 * 首屏会被置成「首屏握手失败: No handler registered for 'app:getBootstrap'」。
 * 建窗被提到了 `registerIpc()` 之前(窗口必须早于闸门,闸门必须早于 `openDatabase()`,
 * 见 `main/index.ts`),所以这是**真的会发生的**,不是理论上的时序担忧。
 *
 * ★ 它长成纯函数、住在 `.ts` 里,是因为它错的唯一形态几乎没法手测:渲染层比主进程
 * 启动快的那一次才会错,重载一次就正常。三种结果由 `__tests__/migration-release.test.ts`
 * 直接把时序摆出来验。
 *
 * 故意不做的事:这里不碰 i18n、不碰组件 —— 它只回答「这一帧画什么」。
 */
import type { MigrationState } from '../../../shared/domain/data-migration'

/**
 * - `blank` —— 什么都不画。主进程还在启动,或者第一份快照还在路上。
 * - `app`   —— 放行,挂 App 去握手。
 * - `gate`  —— 画迁移那一屏(进度 / 失败 / 已跳过)。
 */
export type MigrationGateDecision = 'blank' | 'app' | 'gate'

/**
 * `resolved` = 用户在失败页/已跳过页上已经表过态(重试成功,或点了「继续」),
 * 只差主进程能答得上来了。
 */
export function decideMigrationGate(state: MigrationState, resolved: boolean): MigrationGateDecision {
  /*
    ★ 主进程还不能应答时**一律不放行**,哪怕用户已经点过「继续」——
    那一下点得早(闸门刚结束、`registerIpc()` 还没跑完)的话,挂上的 App 会立刻
    拿到同一个「未登记的频道」。代价只是那一屏多停几十到几百毫秒。

    没有别的东西要画的时候(正常的 idle)返回 `blank`:空白只有一帧,而画一屏
    「正在检查」的过场就是一次白闪。
  */
  if (state.ipcReady !== true) return state.phase === 'idle' ? 'blank' : 'gate'
  if (resolved || state.phase === 'idle') return 'app'
  return 'gate'
}
