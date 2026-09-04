/**
 * 「翻 API 格式开关」这一个判断的测试。
 *
 * 它守的是一类**看不见的**故障:地址没跟着换 → 404;或者换过头 →
 * 用户自己填的地址被吃掉。两个方向各有用例。
 */
import { describe, expect, it } from 'vitest'
import {
  endpointFor,
  findPreset,
  PROVIDER_PRESETS,
  type ProviderPreset
} from '../../../../../../shared/domain/presets'
import {
  baseUrlForProtocol,
  isPresetAdded,
  presetHasProtocol,
  providerFromPreset,
  PRESET_PRIORITY
} from '../provider-edit'

function preset(id: string): ProviderPreset {
  const p = findPreset(id)
  if (p === null) throw new Error(`预设 ${id} 不在表里了 —— 改了 id 就把这条测试一起改`)
  return p
}

function baseOf(id: string, protocol: 'anthropic' | 'openai-chat' | 'openai-responses'): string {
  const e = endpointFor(preset(id), protocol)
  if (e === null) throw new Error(`预设 ${id} 没有 ${protocol} 端点了`)
  return e.baseUrl
}

describe('baseUrlForProtocol:翻 API 格式时地址跟着换', () => {
  it('内置 RoutinAI:anthropic → openai-chat 时补上 /v1', () => {
    const r = baseUrlForProtocol(
      { id: 'routin', baseUrl: baseOf('routin', 'anthropic'), protocol: 'anthropic' },
      'openai-chat'
    )
    expect(r.changed).toBe(true)
    expect(r.baseUrl).toBe(baseOf('routin', 'openai-chat'))
    // ★ 这一条钉的是「两族版本段约定相反」这件事的可见后果
    expect(r.baseUrl.endsWith('/v1')).toBe(true)
  })

  it('反过来也对:openai-chat → anthropic 时去掉 /v1', () => {
    const r = baseUrlForProtocol(
      { id: 'routin', baseUrl: baseOf('routin', 'openai-chat'), protocol: 'openai-chat' },
      'anthropic'
    )
    expect(r.baseUrl).toBe(baseOf('routin', 'anthropic'))
  })

  it('OpenRouter 的两条前缀不同(…/api/v1 ↔ …/api),也要换', () => {
    const r = baseUrlForProtocol(
      { id: 'openrouter', baseUrl: baseOf('openrouter', 'openai-chat'), protocol: 'openai-chat' },
      'anthropic'
    )
    expect(r.changed).toBe(true)
    expect(r.baseUrl).toBe(baseOf('openrouter', 'anthropic'))
  })

  it('★ 用户改过地址就一个字都不动 —— 换掉等于吃掉他的输入', () => {
    const mine = 'https://my-relay.example.com/api'
    const r = baseUrlForProtocol(
      { id: 'routin', baseUrl: mine, protocol: 'anthropic' },
      'openai-chat'
    )
    expect(r).toEqual({ baseUrl: mine, changed: false })
  })

  it('认不出的自定义供应商:保留原地址', () => {
    const r = baseUrlForProtocol(
      { id: '我司内部网关', baseUrl: 'https://gw.corp/v1', protocol: 'openai-chat' },
      'anthropic'
    )
    expect(r).toEqual({ baseUrl: 'https://gw.corp/v1', changed: false })
  })

  it('预设里没有目标协议的端点:保留原地址,不瞎猜一个', () => {
    // RoutinAI 刻意没有 openai-responses —— /v1/responses 是个同名的 WebSocket 端点
    expect(endpointFor(preset('routin'), 'openai-responses')).toBeNull()
    const from = baseOf('routin', 'openai-chat')
    const r = baseUrlForProtocol(
      { id: 'routin', baseUrl: from, protocol: 'openai-chat' },
      'openai-responses'
    )
    expect(r).toEqual({ baseUrl: from, changed: false })
  })

  it('切到同一个协议是空操作', () => {
    const from = baseOf('routin', 'anthropic')
    const r = baseUrlForProtocol(
      { id: 'routin', baseUrl: from, protocol: 'anthropic' },
      'anthropic'
    )
    expect(r).toEqual({ baseUrl: from, changed: false })
  })

  it('两条端点地址相同的预设:换了协议但 changed 为 false,界面就不该提示', () => {
    const twin = PRESET_WITH_SAME_BASE()
    const r = baseUrlForProtocol(
      { id: twin, baseUrl: baseOf(twin, 'openai-chat'), protocol: 'openai-chat' },
      'openai-responses'
    )
    expect(r.baseUrl).toBe(baseOf(twin, 'openai-responses'))
    expect(r.changed).toBe(false)
  })
})

/** OpenAI 自己:chat 和 responses 共用 `https://api.openai.com/v1` */
function PRESET_WITH_SAME_BASE(): string {
  const id = 'openai'
  expect(baseOf(id, 'openai-chat')).toBe(baseOf(id, 'openai-responses'))
  return id
}

describe('presetHasProtocol', () => {
  it('RoutinAI 有 anthropic 和 openai-chat,没有 openai-responses', () => {
    expect(presetHasProtocol('routin', 'anthropic')).toBe(true)
    expect(presetHasProtocol('routin', 'openai-chat')).toBe(true)
    expect(presetHasProtocol('routin', 'openai-responses')).toBe(false)
  })

  it('不认识的供应商一律 false —— 提示语因此不会出现,而不是乱出现', () => {
    expect(presetHasProtocol('我司内部网关', 'anthropic')).toBe(false)
  })
})

describe('providerFromPreset', () => {
  it('★ id 必须原样等于预设 id —— 翻协议换地址全靠它找回端点表', () => {
    const p = providerFromPreset(preset('openrouter'))
    expect(p?.id).toBe('openrouter')
    // 真正要守的不是这个字符串,是「建出来的记录还认得回自己的预设」
    expect(baseUrlForProtocol({ ...p!, protocol: p!.protocol }, 'anthropic').changed).toBe(true)
  })

  it('协议与地址取 endpoints[0](该厂商的主推形态)', () => {
    const p = providerFromPreset(preset('routin'))
    expect(p?.protocol).toBe('anthropic')
    expect(p?.baseUrl).toBe(baseOf('routin', 'anthropic'))
  })

  it('优先级落在内置(50)和演示上游(100)之间', () => {
    expect(PRESET_PRIORITY).toBeGreaterThan(50)
    expect(PRESET_PRIORITY).toBeLessThan(100)
    expect(providerFromPreset(preset('openai'))?.priority).toBe(PRESET_PRIORITY)
  })

  it('每一条预设都建得出来(endpoints 非空是预设表的结构约束)', () => {
    for (const p of PROVIDER_PRESETS) expect(providerFromPreset(p)).not.toBeNull()
  })
})

describe('isPresetAdded', () => {
  it('按 id 查重', () => {
    expect(isPresetAdded(preset('routin'), [{ id: 'routin' }])).toBe(true)
    expect(isPresetAdded(preset('routin'), [{ id: 'demo' }])).toBe(false)
    expect(isPresetAdded(preset('routin'), [])).toBe(false)
  })
})
