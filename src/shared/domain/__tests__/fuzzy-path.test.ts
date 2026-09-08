/**
 * `@` 文件选择器的排序。
 *
 * 排序退化是那种「不报错、只是变难用了」的 bug —— 没有断言就没人看着。
 * 所以这里断言的是**相对次序**,不是具体分数:分档的绝对值随时可以调,
 * 而「敲 chatv 第一条必须是 ChatView.tsx」是不能变的。
 */
import { describe, expect, it } from 'vitest'
import { isSubsequence, rankPaths, scorePath } from '../fuzzy-path'

const F = (path: string): { path: string; name: string } => ({
  path,
  name: path.split('/').pop() as string
})

const FILES = [
  F('src/renderer/src/views/chat/ChatView.tsx'),
  F('src/renderer/src/views/chat/Composer.tsx'),
  F('docs/chat-view-notes.md'),
  F('src/shared/domain/attachment.ts'),
  F('README.md'),
  F('src/main/ipc/attachment.ts')
]

const paths = (q: string, limit = 10): string[] => rankPaths(FILES, q, limit).map((f) => f.path)

describe('scorePath', () => {
  it('★ 不匹配返回 null 而不是 0 —— 0 是个合法的低分', () => {
    expect(scorePath(F('a/b.ts'), 'zzzz')).toBeNull()
    expect(scorePath(F('a/b.ts'), '')).not.toBeNull()
  })

  it('文件名前缀 > 文件名包含 > 整条路径包含', () => {
    const prefix = scorePath(F('x/chat.ts'), 'chat') as number
    const contains = scorePath(F('x/mychat.ts'), 'chat') as number
    const inPath = scorePath(F('chat/x.ts'), 'chat') as number
    expect(prefix).toBeGreaterThan(contains)
    expect(contains).toBeGreaterThan(inPath)
  })

  it('★ 档内的深度惩罚翻不过档 —— 再深的路径也不会掉到下一档', () => {
    const deep = scorePath(F('a/b/c/d/e/f/g/h/i/j/k/chat.ts'), 'chat') as number
    const shallowLowerTier = scorePath(F('chat/x.ts'), 'chat') as number
    expect(deep).toBeGreaterThan(shallowLowerTier)
  })

  it('同一档内浅的排前面', () => {
    const shallow = scorePath(F('a.ts'), 'a') as number
    const deep = scorePath(F('x/y/z/a.ts'), 'a') as number
    expect(shallow).toBeGreaterThan(deep)
  })
})

describe('rankPaths', () => {
  it('★ 敲 chatv 第一条是 ChatView.tsx,不是那篇同名笔记', () => {
    expect(paths('chatv')[0]).toBe('src/renderer/src/views/chat/ChatView.tsx')
  })

  it('★ 带斜杠的写法能用 —— 「哪个目录下的什么」是常见的定位方式', () => {
    expect(paths('chat/comp')).toEqual(['src/renderer/src/views/chat/Composer.tsx'])
  })

  it('缩写走子序列这一档', () => {
    expect(paths('ccv')).toContain('src/renderer/src/views/chat/ChatView.tsx')
  })

  it('★ 真正包含查询串的结果永远排在子序列命中前面', () => {
    const r = paths('attachment')
    expect(r.slice(0, 2).sort()).toEqual([
      'src/main/ipc/attachment.ts',
      'src/shared/domain/attachment.ts'
    ])
  })

  it('空查询给全部,按浅到深', () => {
    expect(paths('')[0]).toBe('README.md')
    expect(paths('')).toHaveLength(FILES.length)
  })

  it('limit 截断', () => {
    expect(paths('', 2)).toHaveLength(2)
  })

  it('★ 稳定排序 —— 同分的两条保持原次序,否则列表会在敲键之间自己跳', () => {
    const same = [F('a/x.ts'), F('b/x.ts'), F('c/x.ts')]
    expect(rankPaths(same, 'x.ts', 10).map((f) => f.path)).toEqual(['a/x.ts', 'b/x.ts', 'c/x.ts'])
  })

  it('一条都不匹配时返回空数组', () => {
    expect(paths('zzzzzz')).toEqual([])
  })
})

describe('isSubsequence', () => {
  it('按顺序出现即可,允许跳字符', () => {
    expect(isSubsequence('chatview', 'ccv')).toBe(false)
    expect(isSubsequence('chatview', 'chv')).toBe(true)
    expect(isSubsequence('chatview', 'vc')).toBe(false)
  })

  it('空 needle 恒真;空 hay 只对空 needle 为真', () => {
    expect(isSubsequence('abc', '')).toBe(true)
    expect(isSubsequence('', '')).toBe(true)
    expect(isSubsequence('', 'a')).toBe(false)
  })

  it('★ 两边同按码元走 —— 文件名里的 emoji 不该让匹配错位', () => {
    expect(isSubsequence('a🎉b', 'ab')).toBe(true)
    expect(isSubsequence('a🎉b', '🎉')).toBe(true)
  })
})
