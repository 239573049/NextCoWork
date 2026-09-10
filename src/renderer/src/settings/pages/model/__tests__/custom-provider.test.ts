/**
 * 「自定义供应商」的测试。
 *
 * 守的都是**静默错**:id 撞上预设会让翻开关时地址被换走、id 撞车会让
 * 后建的一家按 id 覆盖掉先建的、放行一个非 http 地址会拖到发请求时才炸。
 * 三条都不会在建的当场报错,所以只能靠测试钉住。
 */
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, findPreset } from '../../../../../../shared/domain/presets'
import {
  CUSTOM_PROVIDER_PREFIX,
  customProviderDraft,
  customProviderId,
  isCustomProviderId,
  validateCustomProvider
} from '../custom-provider'
import { PRESET_PRIORITY } from '../provider-edit'

describe('customProviderId', () => {
  it('名字转写成 slug 并带上前缀', () => {
    expect(customProviderId('My Gateway', [])).toBe('custom-my-gateway')
  })

  it('纯中文名不会退化成空 id —— 否则第二家会按 id 覆盖第一家', () => {
    const id = customProviderId('公司内网中转', [])
    expect(id).toBe('custom-provider')
    expect(id).not.toBe(CUSTOM_PROVIDER_PREFIX)
  })

  it('重名顺延而不是报错', () => {
    expect(customProviderId('中转', ['custom-provider'])).toBe('custom-provider-2')
    expect(customProviderId('中转', ['custom-provider', 'custom-provider-2'])).toBe(
      'custom-provider-3'
    )
  })

  it('生成的 id 认不出预设 —— 这是「翻开关不换地址」的前提', () => {
    for (const name of ['openai', 'anthropic', 'OpenRouter', 'ollama']) {
      expect(findPreset(customProviderId(name, []))).toBeNull()
    }
  })

  it('id 里没有斜杠 —— modelSelectionKey 靠第一个斜杠解析', () => {
    expect(customProviderId('a/b/c', [])).not.toContain('/')
  })
})

describe('预设表和自定义 id 空间不重叠', () => {
  it('没有任何预设 id 以 custom- 开头', () => {
    expect(PROVIDER_PRESETS.filter((p) => isCustomProviderId(p.id))).toEqual([])
  })
})

describe('validateCustomProvider', () => {
  it('名字和地址都给了就放行', () => {
    expect(validateCustomProvider({ name: '中转', baseUrl: 'https://api.x.com/v1' })).toBeNull()
  })

  it('空名字 / 空地址各自拦下', () => {
    expect(validateCustomProvider({ name: '  ', baseUrl: 'https://api.x.com' })).toBe(
      'name-required'
    )
    expect(validateCustomProvider({ name: '中转', baseUrl: '   ' })).toBe('url-required')
  })

  it('不是地址的东西拦下', () => {
    expect(validateCustomProvider({ name: '中转', baseUrl: '这不是地址' })).toBe('url-invalid')
  })

  it('非 http(s) 拦下 —— 它们能被 new URL 收下,却要到发请求时才炸', () => {
    expect(validateCustomProvider({ name: '中转', baseUrl: 'file:///etc/passwd' })).toBe(
      'url-invalid'
    )
  })

  it('裸域名不拦 —— normalizeBaseUrl 会补 https', () => {
    expect(validateCustomProvider({ name: '中转', baseUrl: 'api.x.com/v1' })).toBeNull()
  })

  it('本机地址不拦', () => {
    expect(validateCustomProvider({ name: '本地', baseUrl: 'http://127.0.0.1:11434/v1' })).toBeNull()
  })

  it('形状可疑的一律放行 —— 那是提示的活,不是拦截的活', () => {
    // Anthropic 端点带 /v1 十有八九不对,但用户的私有部署可能真是这样
    expect(validateCustomProvider({ name: '中转', baseUrl: 'https://api.x.com/v1' })).toBeNull()
  })
})

describe('customProviderDraft', () => {
  it('整条请求地址会被整理成 base', () => {
    const d = customProviderDraft(
      { name: '中转', baseUrl: 'https://api.x.com/v1/chat/completions', protocol: 'openai-chat' },
      []
    )
    expect(d.baseUrl).toBe('https://api.x.com/v1')
  })

  it('名字去空白,优先级和预设建出来的一致', () => {
    const d = customProviderDraft(
      { name: '  中转  ', baseUrl: 'api.x.com', protocol: 'anthropic' },
      []
    )
    expect(d.name).toBe('中转')
    expect(d.priority).toBe(PRESET_PRIORITY)
    expect(d.enabled).toBe(true)
  })

  it('credentialRef 是占位且跟着 id 走,不含明文密钥', () => {
    const d = customProviderDraft({ name: 'Gw', baseUrl: 'api.x.com', protocol: 'openai-chat' }, [])
    expect(d.credentialRef).toBe(`provider:${d.id}`)
  })

  it('已存在的 id 会被让开', () => {
    const d = customProviderDraft(
      { name: 'Gw', baseUrl: 'api.x.com', protocol: 'openai-chat' },
      ['custom-gw']
    )
    expect(d.id).toBe('custom-gw-2')
  })
})
