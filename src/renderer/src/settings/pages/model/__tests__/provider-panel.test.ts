import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AnthropicCacheTtl, UpstreamProvider } from '../../../../../../shared/domain/provider'
import { Segmented } from '../../../../components/ui/Segmented'
import { I18nProvider, type Locale } from '../../../../i18n'
import { ProviderPanel } from '../ProviderPanel'
import type { ProviderEntry } from '../enabled-models'

function entry(
  protocol: UpstreamProvider['protocol'],
  cacheTtl?: AnthropicCacheTtl,
  id = 'relay'
): ProviderEntry {
  return {
    provider: {
      id,
      name: id === 'relay' ? 'Relay' : id,
      protocol,
      baseUrl: 'https://relay.example.com',
      credentialRef: `provider:${id}`,
      priority: 10,
      enabled: true,
      ...(cacheTtl === undefined
        ? {}
        : { protocolOptions: { anthropic: { cacheTtl } } })
    },
    aliases: [],
    primaryAlias: null,
    isDefault: false
  }
}

function renderPanel(
  protocol: UpstreamProvider['protocol'],
  cacheTtl?: AnthropicCacheTtl,
  locale: Locale = 'zh-CN',
  id = 'relay'
): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: locale,
      children: createElement(ProviderPanel, { entry: entry(protocol, cacheTtl, id) })
    })
  )
}

describe('ProviderPanel · 协议专属配置', () => {
  it('Anthropic 显示三档提示缓存，旧 Provider 默认关闭', () => {
    const html = renderPanel('anthropic')
    expect(html).toContain('提示缓存')
    expect(html).toContain('关闭')
    expect(html).toContain('5 分钟')
    expect(html).toContain('1 小时')
    expect(html).toMatch(/aria-checked="true"[^>]*>关闭<\/button>/)
    expect(html).toContain('1 小时写入通常更贵')
    expect(html).toContain('Anthropic 兼容中转站不支持')
  })

  it('已保存的 1 小时档位在重新渲染时恢复', () => {
    const html = renderPanel('anthropic', '1h')
    expect(html).toMatch(/aria-checked="true"[^>]*>1 小时<\/button>/)
  })

  it('OpenAI 隐藏 Anthropic 配置，也不暗示 prompt_cache_key 已实现', () => {
    const html = renderPanel('openai-responses')
    expect(html).not.toContain('提示缓存')
    expect(html).not.toContain('prompt_cache_key')
    expect(html).not.toContain('命中率')
    expect(html).toContain('/v1/responses')
  })

  it('两种协议页面都不提供 metadata.user_id 编辑框', () => {
    expect(renderPanel('anthropic')).not.toContain('metadata.user_id')
    expect(renderPanel('openai-chat', undefined, 'en-US')).not.toContain('metadata.user_id')
  })

  it('有官方密钥入口的内置提供商显示跳转按钮，自定义和本地提供商不显示', () => {
    expect(renderPanel('openai-chat', undefined, 'zh-CN', 'openai')).toContain('获取 API Key')
    expect(renderPanel('openai-chat', undefined, 'en-US', 'openai')).toContain('Get API key')
    expect(renderPanel('openai-chat', undefined, 'zh-CN', 'sensenova')).toContain(
      '获取 Access Key'
    )
    expect(renderPanel('openai-chat', undefined, 'zh-CN', 'spark')).toContain(
      '获取 API Password'
    )
    expect(renderPanel('anthropic', undefined, 'zh-CN', 'kimi-coding')).toContain('获取订阅密钥')
    expect(renderPanel('openai-chat')).not.toContain('获取 API Key')
    expect(renderPanel('openai-chat', undefined, 'zh-CN', 'ollama')).not.toContain('获取 API Key')
  })
})

describe('Segmented · 保存期间禁用', () => {
  it('禁用状态传递给分段控件内的每一个原生按钮', () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, {
        value: 'off',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' }
        ],
        onChange: () => {},
        label: 'Cache',
        disabled: true
      })
    )
    expect(html).toContain('aria-disabled="true"')
    expect(html.match(/ disabled=""/g)).toHaveLength(2)
  })
})
