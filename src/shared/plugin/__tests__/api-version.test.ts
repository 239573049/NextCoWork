/**
 * 插件 API 版本的兼容判定。
 *
 * 钉住的是那个让**所有按官方模板写的插件变成红色**的 bug(见
 * `shared/plugin/api-version.ts` 文件头):`engines` 必须比 API 版本,
 * 而不是比应用版本;并且 0.2 那批声明要能继续跑、同时被标成弃用。
 */
import { describe, expect, it } from 'vitest'
import { LEGACY_API_RANGES, PLUGIN_API_VERSION, engineCompatibility } from '../api-version'

describe('engineCompatibility', () => {
  it('accepts a range that matches the current plugin API version', () => {
    expect(engineCompatibility('^0.3.0', '0.3.0')).toBe('ok')
    expect(engineCompatibility('^0.3.0', '0.3.7')).toBe('ok')
    expect(engineCompatibility('>=0.3.0', '0.9.0')).toBe('ok')
  })

  it('keeps the retired 0.2 declarations running, flagged as deprecated', () => {
    for (const range of LEGACY_API_RANGES) {
      expect(engineCompatibility(range, '0.3.0'), range).toBe('deprecated')
    }
    // `>=0.2.0` 本来就被 0.3.0 满足 —— 它走 ok,不需要弃用通道
    expect(engineCompatibility('>=0.2.0', '0.3.0')).toBe('ok')
  })

  it('rejects a range that is neither satisfied nor a known legacy declaration', () => {
    expect(engineCompatibility('^9.0.0', '0.3.0')).toBe('incompatible')
    // 读不懂的 range 是 incompatible,不是 ok —— 宁可装不上也不在语义不明的约束下跑第三方代码
    expect(engineCompatibility('latest', '0.3.0')).toBe('incompatible')
    expect(engineCompatibility('', '0.3.0')).toBe('incompatible')
  })

  it('defaults to the shipped API version, which the scaffold default must satisfy', () => {
    expect(engineCompatibility(`^${PLUGIN_API_VERSION}`)).toBe('ok')
  })
})
