import { describe, expect, it } from 'vitest'
import { EXTERNAL_NAME_MAX, DESCRIPTION_MAX } from '../../../../shared/agent/tool'
import {
  fnv1a32,
  isValidExternalName,
  sanitizeDescription,
  sanitizeToolName,
  ToolNamer
} from '../naming'

describe('sanitizeToolName', () => {
  it('合法名字原样通过', () => {
    expect(sanitizeToolName('read_file')).toBe('read_file')
    expect(sanitizeToolName('mcp__github__create-pr')).toBe('mcp__github__create-pr')
  })

  /** ⚠️ 名字是 MCP server 自己声明的,不可信 —— 白名单而不是黑名单 */
  it('非法字符换成下划线', () => {
    expect(sanitizeToolName('read file')).toBe('read_file')
    expect(sanitizeToolName('a.b/c\\d')).toBe('a_b_c_d')
    expect(sanitizeToolName('读取文件')).toBe('__') // 4 个下划线压成 2 个
  })

  /**
   * 保住 `mcp__server__tool` 的双下划线约定,又不让一个全中文的名字
   * 变成 40 个下划线 —— 后者在工具列表里根本没法读。
   */
  it('三个以上的下划线压成两个,但保留双下划线', () => {
    expect(sanitizeToolName('a___b')).toBe('a__b')
    expect(sanitizeToolName('a__b')).toBe('a__b')
    expect(sanitizeToolName('a_b')).toBe('a_b')
  })

  it('全部字符都非法时给一个兜底名字', () => {
    expect(sanitizeToolName('')).toBe('tool')
  })

  /** 消毒后必须真的能过上游那条正则,否则消毒等于没做 */
  it('消毒结果总是合法的 externalName', () => {
    for (const raw of ['读取文件', 'a b c', '!!!', 'ok', '🚀tool🚀', 'a'.repeat(200)]) {
      const s = sanitizeToolName(raw)
      expect(/^[a-zA-Z0-9_-]+$/.test(s), `${raw} → ${s}`).toBe(true)
    }
  })
})

describe('sanitizeDescription', () => {
  it('普通描述原样通过', () => {
    expect(sanitizeDescription('读取一个文件')).toBe('读取一个文件')
  })

  /** 换行是有意义的排版,不能一起削掉 */
  it('保留换行与制表符', () => {
    expect(sanitizeDescription('第一行\n第二行\t缩进')).toBe('第一行\n第二行\t缩进')
  })

  /**
   * ⚠️ 描述直接进系统提示词。不可见的控制字符能干扰上游的分段,
   * 也能让日志里看起来一模一样的两条描述其实不同。
   */
  it('削掉 C0 控制字符与 DEL', () => {
    expect(sanitizeDescription('a\u0000b\u0007c\u001Bd\u007Fe')).toBe('abcde')
  })

  it('超长描述被截断并带省略号', () => {
    const out = sanitizeDescription('x'.repeat(DESCRIPTION_MAX + 100))
    expect(out).toHaveLength(DESCRIPTION_MAX)
    expect(out.endsWith('...')).toBe(true)
  })

  it('刚好等于上限时不截断', () => {
    expect(sanitizeDescription('x'.repeat(DESCRIPTION_MAX))).toHaveLength(DESCRIPTION_MAX)
  })
})

describe('fnv1a32', () => {
  it('确定性', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'))
  })
  it('总是 8 位十六进制', () => {
    for (const s of ['', 'a', 'abc', '中文', 'x'.repeat(1000)]) {
      expect(fnv1a32(s), s.slice(0, 10)).toMatch(/^[0-9a-f]{8}$/)
    }
  })
  it('不同输入给出不同哈希', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(fnv1a32(`mcp__server__tool_${i}`))
    expect(seen.size).toBe(500)
  })
})

describe('ToolNamer', () => {
  it('短名字原样使用', () => {
    expect(new ToolNamer().nameFor('read_file')).toBe('read_file')
  })

  /**
   * ★ 本文件最重要的一条:映射**在一次会话内必须稳定**。
   * 已落盘的转录里存的是当时那个 externalName,变了历史就配不上了。
   */
  it('同一个 internalId 永远得到同一个名字', () => {
    const n = new ToolNamer()
    const long = 'mcp__github-enterprise-internal__create_pull_request_review_comment'
    const first = n.nameFor(long)
    for (let i = 0; i < 5; i++) expect(n.nameFor(long)).toBe(first)
  })

  /**
   * ★ 超 64 字符换来的是一个只说「invalid tool name」的 400 ——
   * 而那时你会先怀疑自己的 schema。
   */
  it('超长名字截断到 64 且带哈希后缀', () => {
    const long = 'mcp__github-enterprise-internal__create_pull_request_review_comment'
    expect(long.length).toBeGreaterThan(EXTERNAL_NAME_MAX)
    const name = new ToolNamer().nameFor(long)
    expect(name).toHaveLength(EXTERNAL_NAME_MAX)
    expect(isValidExternalName(name)).toBe(true)
    expect(name).toMatch(/_[0-9a-f]{8}$/)
  })

  /**
   * ★ 两个长名字的**前 55 个字符相同**时,光截断会撞名 ——
   * 而撞名意味着两个不同的工具在模型眼里合二为一,调用哪个全看 Map 顺序。
   */
  it('前缀相同的两个长名字不会撞名', () => {
    const n = new ToolNamer()
    const prefix = 'mcp__some-really-long-server-name-here__operation_'
    const a = n.nameFor(`${prefix}alpha_with_more_tail`)
    const b = n.nameFor(`${prefix}beta_with_more_tail`)
    expect(a).not.toBe(b)
    expect(a).toHaveLength(EXTERNAL_NAME_MAX)
    expect(b).toHaveLength(EXTERNAL_NAME_MAX)
  })

  /** 短名字之间的撞名同样要处理:两个不同 internalId 消毒后可能相同 */
  it('消毒后相同的两个短名字不会撞名', () => {
    const n = new ToolNamer()
    const a = n.nameFor('read file') // → read_file
    const b = n.nameFor('read/file') // → read_file,撞了
    expect(a).toBe('read_file')
    expect(b).not.toBe(a)
    expect(isValidExternalName(b)).toBe(true)
  })

  it('反查得到 internalId', () => {
    const n = new ToolNamer()
    const long = 'mcp__x'.repeat(20)
    const name = n.nameFor(long)
    expect(n.toInternal(name)).toBe(long)
    expect(n.toInternal('从没分配过')).toBeUndefined()
  })

  /**
   * ★ 名字**永不回收**:MCP server 断开后,历史里那条 tool_use 仍引用着旧名字。
   * 回收了就意味着同一个名字在一次会话里先后指向两个不同的工具。
   */
  it('大量工具批量分配后全部唯一且合法', () => {
    const n = new ToolNamer()
    const names = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const name = n.nameFor(`mcp__server-with-a-very-long-identifier__tool_number_${i}`)
      expect(isValidExternalName(name), name).toBe(true)
      names.add(name)
    }
    expect(names.size).toBe(300)
  })
})
