/**
 * 闸门放行判据的时序测试。
 *
 * 这一条判据错的唯一形态是「渲染层比主进程启动快」—— 起一次 Electron 也未必撞得上,
 * 所以这里把几种启动时序直接摆出来:哪些情况下**不能**挂 App(挂了就是
 * 「首屏握手失败: No handler registered for 'app:getBootstrap'」)。
 */
import { describe, expect, it } from 'vitest'
import type { MigrationState } from '../../../../shared/domain/data-migration'
import { decideMigrationGate } from '../migration-release'

/** 只写关心的那几位,其余按「什么都没发生」补全。 */
function state(over: Partial<MigrationState>): MigrationState {
  return {
    phase: 'idle',
    steps: [],
    completed: [],
    current: null,
    ratio: null,
    failure: null,
    merged: null,
    undoAvailable: false,
    ipcReady: false,
    ...over
  }
}

describe('decideMigrationGate', () => {
  it('★ 主进程还没跑完 registerIpc 时,idle 也不放行 —— 那一次 invoke 会撞上未登记的频道', () => {
    expect(decideMigrationGate(state({ phase: 'idle', ipcReady: false }), false)).toBe('blank')
  })

  it('主进程能应答之后,idle 直接放行', () => {
    expect(decideMigrationGate(state({ phase: 'idle', ipcReady: true }), false)).toBe('app')
  })

  it('迁移进行中照常画那一屏,与主进程能不能应答无关', () => {
    expect(decideMigrationGate(state({ phase: 'running', ipcReady: false }), false)).toBe('gate')
    expect(decideMigrationGate(state({ phase: 'running', ipcReady: true }), false)).toBe('gate')
  })

  it('失败页照常画;「跳过并继续」在主进程能应答之前点了也不生效', () => {
    expect(decideMigrationGate(state({ phase: 'failed', ipcReady: false }), false)).toBe('gate')
    expect(decideMigrationGate(state({ phase: 'failed', ipcReady: false }), true)).toBe('gate')
    expect(decideMigrationGate(state({ phase: 'failed', ipcReady: true }), true)).toBe('app')
  })

  it('「已跳过」那一屏要用户点过继续才放行', () => {
    expect(decideMigrationGate(state({ phase: 'skipped', ipcReady: true }), false)).toBe('gate')
    expect(decideMigrationGate(state({ phase: 'skipped', ipcReady: true }), true)).toBe('app')
  })
})
