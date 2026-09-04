/**
 * 拉模型列表的三处协议差异 + 解析的容错边界。
 *
 * ★ 这一组守的坏**全是静默的**:路径错了是 404(还算看得见),
 * 但「Anthropic 少拉了一页」「解析把一条垃圾当成了模型名」这两种,
 * 界面上都长得完全正常 —— 只是列表短了一截,或者多出一个永远 404 的别名。
 */
import { describe, expect, it } from 'vitest'
import { REQUEST_PATH } from '../../../../shared/domain/baseurl'
import {
  MODEL_LIST_PATH,
  modelListErrorMessage,
  modelListRequest,
  parseModelList
} from '../model-list'

describe('modelListRequest · 路径', () => {
  /**
   * ★★ 这一条钉的是两族**反过来的版本段约定**(`REQUEST_PATH` 上面那张表)。
   * 两个 base 都是各自协议的规范形式:Anthropic 的不带 `/v1`,OpenAI 族的带。
   */
  it('Anthropic 的 base 不带 /v1,路径自己补', () => {
    const { url } = modelListRequest('anthropic', 'https://api.routin.ai', 'k')
    expect(url.startsWith('https://api.routin.ai/v1/models')).toBe(true)
  })

  it('OpenAI 族的版本段在 base 里,路径只有 /models', () => {
    expect(modelListRequest('openai-chat', 'https://api.openai.com/v1', 'k').url).toBe(
      'https://api.openai.com/v1/models'
    )
  })

  it('★ 版本段不是 /v1 的那几家也对 —— 拼死 /v1 的写法在这里会多一段', () => {
    // 智谱、火山、百炼这一类。它们正是 `REQUEST_PATH` 注释里加粗的那几家
    expect(modelListRequest('openai-chat', 'https://open.bigmodel.cn/api/paas/v4', null).url).toBe(
      'https://open.bigmodel.cn/api/paas/v4/models'
    )
    expect(
      modelListRequest('openai-chat', 'https://ark.cn-beijing.volces.com/api/v3', null).url
    ).toBe('https://ark.cn-beijing.volces.com/api/v3/models')
  })

  it('Gemini 兼容层的尾斜杠不会拼出双斜杠', () => {
    expect(
      modelListRequest(
        'openai-chat',
        'https://generativelanguage.googleapis.com/v1beta/openai/',
        'k'
      ).url
    ).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models')
  })

  it('用户手填 …/anthropic/v1 时不会拼出 /v1/v1(和真实请求共用同一条去重)', () => {
    const { url } = modelListRequest('anthropic', 'https://api.deepinfra.com/v1/anthropic/v1', 'k')
    expect(url.includes('/v1/v1/')).toBe(false)
  })

  it('★ 和 REQUEST_PATH 是同一套约定的两张表:两张都必须按协议给出路径', () => {
    for (const p of ['anthropic', 'openai-chat', 'openai-responses'] as const) {
      // 版本段落在同一侧 —— 谁带 /v1,两张表里必须一致
      expect(MODEL_LIST_PATH[p].startsWith('/v1/')).toBe(REQUEST_PATH[p].startsWith('/v1/'))
    }
  })

  it('Responses 协议和 Chat 共用 /models —— 它没有自己的列表端点', () => {
    expect(MODEL_LIST_PATH['openai-responses']).toBe(MODEL_LIST_PATH['openai-chat'])
  })
})

describe('modelListRequest · 鉴权头', () => {
  it('Anthropic 用 x-api-key + anthropic-version', () => {
    const { headers } = modelListRequest('anthropic', 'https://api.routin.ai', 'sk-ant')
    expect(headers['x-api-key']).toBe('sk-ant')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers.authorization).toBeUndefined()
  })

  it('OpenAI 族用 Authorization: Bearer', () => {
    const { headers } = modelListRequest('openai-chat', 'https://api.openai.com/v1', 'sk-oa')
    expect(headers.authorization).toBe('Bearer sk-oa')
    expect(headers['x-api-key']).toBeUndefined()
  })

  /**
   * ★ 免鉴权那几家(预设表的 `modelListPublic`)要的是**整个头不出现**,
   * 不是一个空值的头 —— `Bearer ` 会被有些网关判成鉴权失败,
   * 报出来的 401 会让用户去查一把他根本没填的 key。
   */
  it('★ apiKey 为 null 时鉴权头整个不出现,而不是一个空的 Bearer', () => {
    const oa = modelListRequest('openai-chat', 'https://openrouter.ai/api/v1', null)
    expect('authorization' in oa.headers).toBe(false)
    const an = modelListRequest('anthropic', 'https://api.routin.ai', null)
    expect('x-api-key' in an.headers).toBe(false)
    // 版本头和鉴权无关,该照旧带着
    expect(an.headers['anthropic-version']).toBe('2023-06-01')
  })
})

describe('modelListRequest · 分页', () => {
  /**
   * ★★ 这一条是全组最重要的。Anthropic 的 `/v1/models` 默认只回 **20** 条,
   * 漏了 `limit` 的表现不是报错,是列表**少了一截** —— 而用户要的那个
   * 恰好可能在第 21 条,他只会以为这家没有那个模型。
   */
  it('★ Anthropic 必须显式要一页大的,否则默认只回 20 条', () => {
    const { url } = modelListRequest('anthropic', 'https://api.routin.ai', 'k')
    const limit = new URL(url).searchParams.get('limit')
    expect(limit).not.toBeNull()
    expect(Number(limit)).toBeGreaterThan(100)
  })

  it('OpenAI 族一次回全,不加参数', () => {
    expect(modelListRequest('openai-chat', 'https://api.openai.com/v1', 'k').url).not.toContain('?')
  })
})

describe('parseModelList · 各家的真实响应形状', () => {
  it('Anthropic:data[] + display_name', () => {
    const body = {
      data: [
        { type: 'model', id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
        { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' }
      ],
      has_more: false
    }
    expect(parseModelList('anthropic', body)).toEqual([
      { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5' }
    ])
  })

  it('OpenAI:data[] + object/created/owned_by,没有显示名', () => {
    const body = {
      object: 'list',
      data: [
        { id: 'gpt-5.6', object: 'model', created: 1686935002, owned_by: 'openai' },
        { id: 'gpt-5.6-sol', object: 'model', created: 1686935002, owned_by: 'openai' }
      ]
    }
    expect(parseModelList('openai-chat', body)).toEqual([{ id: 'gpt-5.6' }, { id: 'gpt-5.6-sol' }])
  })

  it('★ OpenAI 协议下不去读 display_name —— 那是 Anthropic 的字段', () => {
    const body = { data: [{ id: 'x', display_name: '不该被采信的名字' }] }
    expect(parseModelList('openai-chat', body)).toEqual([{ id: 'x' }])
  })

  it('外壳容错:裸数组 / models 键都认(兼容层各家自己实现的)', () => {
    expect(parseModelList('openai-chat', [{ id: 'a' }, 'b'])).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(parseModelList('openai-chat', { models: [{ id: 'c' }] })).toEqual([{ id: 'c' }])
  })

  it('保持上游顺序,不按字典序重排 —— Anthropic 是新的在前,那个顺序有信息量', () => {
    const body = { data: [{ id: 'z-new' }, { id: 'a-old' }] }
    expect(parseModelList('openai-chat', body).map((m) => m.id)).toEqual(['z-new', 'a-old'])
  })

  it('同一个 id 出现两次只留一条', () => {
    expect(parseModelList('openai-chat', { data: [{ id: 'a' }, { id: 'a' }] })).toHaveLength(1)
  })
})

describe('parseModelList · 认不出的一律丢掉', () => {
  /**
   * ★★ 丢掉而不是编一个占位。编出来的那条会作为 `upstreamModel` 存进别名表,
   * 然后在某一次真实对话里以 404 出现 —— 那时用户早忘了他是从这个列表勾的。
   * **少一条是看得见的,多一条错的不是。**
   */
  it('没有 id / id 不是字符串 / id 是空串的条目全部丢掉', () => {
    const body = {
      data: [
        { id: 'good' },
        { object: 'model', owned_by: 'x' },
        { id: 123 },
        { id: '   ' },
        null,
        42
      ]
    }
    expect(parseModelList('openai-chat', body)).toEqual([{ id: 'good' }])
  })

  it('整个响应不是预期形状时返回空数组,不抛 —— 界面显示「没拉到」即可', () => {
    for (const junk of [null, undefined, 'nope', 42, {}, { data: 'nope' }]) {
      expect(parseModelList('openai-chat', junk)).toEqual([])
    }
  })

  it('id 两端的空白会被剪掉(存进别名表的必须是能直接下发的字符串)', () => {
    expect(parseModelList('openai-chat', { data: [{ id: '  gpt-5.6  ' }] })).toEqual([
      { id: 'gpt-5.6' }
    ])
  })
})

describe('modelListErrorMessage', () => {
  it('401 / 403 单独一句 —— 这条路上最常见的失败,而修法和别的都不同', () => {
    const m = modelListErrorMessage(401, '{"error":{"message":"invalid x-api-key"}}')
    expect(m).toContain('密钥')
    expect(m).toContain('invalid x-api-key')
  })

  it('404 提示去看版本段 —— 拉列表 404 基本都是 base 的版本段写错了', () => {
    expect(modelListErrorMessage(404, '')).toContain('版本段')
  })

  /**
   * ★ 网关出错回的是一整页 HTML。原样贴进弹窗的话,用户看见几 KB 标签,
   * 分不出这是网关拦的还是 key 错了。
   */
  it('★ HTML 错误页不往界面上贴,只留状态码', () => {
    const m = modelListErrorMessage(502, '<!DOCTYPE html>\n<html><body>Bad Gateway</body></html>')
    expect(m).not.toContain('<')
    expect(m).toContain('502')
  })

  it('非 JSON 的纯文本只取第一行并截断', () => {
    const m = modelListErrorMessage(500, `${'x'.repeat(500)}\n第二行不要`)
    expect(m).not.toContain('第二行不要')
    expect(m.length).toBeLessThan(260)
  })

  it('{message} 这种没有 error 包一层的也认', () => {
    expect(modelListErrorMessage(400, '{"message":"model list disabled"}')).toContain(
      'model list disabled'
    )
  })
})
