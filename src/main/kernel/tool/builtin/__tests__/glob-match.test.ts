import { describe, expect, it } from 'vitest'
import { compileGlob, globMatch, normalizeGlobPath } from '../glob-match'

/**
 * 纯函数测试 —— 零 IO,所以可以把边界情况铺满。
 *
 * 这个文件存在的首要理由是**那一条**:双星后面跟斜杠时,必须能匹配零层目录。
 * 写错的话没有任何东西会报错,只是「搜所有 ts 文件」会静默漏掉根目录下的那几个,
 * 而返回的列表看起来完全合理。见 `glob-match.ts` 里对应的 ★。
 *
 * (顺带:这段注释里刻意不写出「双星加斜杠」的字面形式 —— 那三个字符会把块注释
 * 提前关掉,而报错停在几十行之后的一个完全无关的位置上。)
 */

/** 大小写敏感地编译 —— 免得测试结果跟着跑测试的机器变 */
function m(pattern: string, path: string): boolean {
  return compileGlob(pattern, true).test(normalizeGlobPath(path))
}

describe('compileGlob · 单星不跨目录', () => {
  it('* 匹配段内任意字符', () => {
    expect(m('*.ts', 'a.ts')).toBe(true)
    expect(m('*.ts', 'index.ts')).toBe(true)
    expect(m('*.ts', '.ts')).toBe(true)
  })

  it('★ * 不跨 /', () => {
    expect(m('*.ts', 'src/a.ts')).toBe(false)
    expect(m('src/*.ts', 'src/a.ts')).toBe(true)
    expect(m('src/*.ts', 'src/main/a.ts')).toBe(false)
  })

  it('后缀不同不匹配', () => {
    expect(m('*.ts', 'a.tsx')).toBe(false)
    expect(m('*.ts', 'a.ts.bak')).toBe(false)
  })
})

describe('compileGlob · 双星', () => {
  /**
   * ★ 这一条是整个文件的核心。双星后面跟斜杠时必须允许**零层**,
   * 否则根目录下的文件全被漏掉。
   */
  it('★ **/ 匹配零层 —— 根目录下的文件也要命中', () => {
    expect(m('**/*.ts', 'a.ts')).toBe(true)
    expect(m('**/*.ts', 'src/a.ts')).toBe(true)
    expect(m('**/*.ts', 'src/main/kernel/a.ts')).toBe(true)
  })

  it('带前缀的 ** 同样允许零层', () => {
    expect(m('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(m('src/**/*.ts', 'src/main/a.ts')).toBe(true)
    expect(m('src/**/*.ts', 'lib/a.ts')).toBe(false)
  })

  it('裸 ** 匹配任意字符(含斜杠)', () => {
    expect(m('src/**', 'src/a.ts')).toBe(true)
    expect(m('src/**', 'src/main/deep/a.ts')).toBe(true)
    expect(m('**', 'anything/at/all.txt')).toBe(true)
  })

  it('** 不会让前缀失效', () => {
    expect(m('**/test/**', 'src/test/a.ts')).toBe(true)
    expect(m('**/test/**', 'src/spec/a.ts')).toBe(false)
  })
})

describe('compileGlob · ? 与花括号', () => {
  it('? 匹配段内单个字符', () => {
    expect(m('a?.ts', 'ab.ts')).toBe(true)
    expect(m('a?.ts', 'a.ts')).toBe(false)
    expect(m('a?.ts', 'abc.ts')).toBe(false)
  })

  it('? 不跨 /', () => {
    expect(m('a?b', 'a/b')).toBe(false)
  })

  it('{a,b} 二选一', () => {
    expect(m('*.{ts,tsx}', 'a.ts')).toBe(true)
    expect(m('*.{ts,tsx}', 'a.tsx')).toBe(true)
    expect(m('*.{ts,tsx}', 'a.js')).toBe(false)
  })

  it('花括号里可以有多项,也可以和 ** 一起用', () => {
    expect(m('**/*.{js,jsx,mjs,cjs}', 'src/a.mjs')).toBe(true)
    expect(m('**/*.{js,jsx,mjs,cjs}', 'a.cjs')).toBe(true)
    expect(m('**/*.{js,jsx,mjs,cjs}', 'a.ts')).toBe(false)
  })

  /** pattern 来自模型,坏输入不能抛异常 —— 大不了匹配不到 */
  it('花括号没闭合不抛异常', () => {
    expect(() => compileGlob('*.{ts,tsx')).not.toThrow()
    expect(() => compileGlob('}}}')).not.toThrow()
    expect(() => compileGlob('{')).not.toThrow()
  })
})

describe('compileGlob · 字面量与转义', () => {
  it('正则元字符按字面量处理', () => {
    expect(m('a.ts', 'a.ts')).toBe(true)
    // 没转义的话 `.` 会匹配任意字符
    expect(m('a.ts', 'axts')).toBe(false)
    expect(m('a+b.txt', 'a+b.txt')).toBe(true)
    expect(m('(x).txt', '(x).txt')).toBe(true)
    expect(m('a$b', 'a$b')).toBe(true)
  })

  /** 明确不支持的语法要按字面量走,不能静默变成别的意思 */
  it('字符类被当成字面量,不是「三选一」', () => {
    expect(m('[abc].ts', '[abc].ts')).toBe(true)
    expect(m('[abc].ts', 'a.ts')).toBe(false)
  })

  it('锚定在两端 —— 不是子串匹配', () => {
    expect(m('*.ts', 'a.ts.map')).toBe(false)
    expect(m('src/a.ts', 'x/src/a.ts')).toBe(false)
  })
})

describe('normalizeGlobPath', () => {
  it('去掉开头的 ./', () => {
    expect(normalizeGlobPath('./a.ts')).toBe('a.ts')
    expect(normalizeGlobPath('././a.ts')).toBe('a.ts')
  })

  it('中间的 ./ 不动 —— 那不是我们的活,路径围栏已经折叠过了', () => {
    expect(normalizeGlobPath('a/./b')).toBe('a/./b')
  })

  it('普通路径原样返回', () => {
    expect(normalizeGlobPath('src/main/a.ts')).toBe('src/main/a.ts')
  })
})

describe('globMatch · 大小写与缓存', () => {
  it('显式大小写敏感时区分大小写', () => {
    expect(globMatch('*.TS', 'a.ts', true)).toBe(false)
    expect(globMatch('*.ts', 'a.ts', true)).toBe(true)
  })

  it('显式大小写不敏感时不区分', () => {
    expect(globMatch('*.TS', 'a.ts', false)).toBe(true)
    expect(globMatch('*.ts', 'A.TS', false)).toBe(true)
  })

  /** 同一个 pattern 在两种敏感度下必须各缓存各的,不能互相顶掉 */
  it('★ 缓存按敏感度分键 —— 两种模式不会互相污染', () => {
    expect(globMatch('*.TS', 'a.ts', false)).toBe(true)
    expect(globMatch('*.TS', 'a.ts', true)).toBe(false)
    expect(globMatch('*.TS', 'a.ts', false)).toBe(true)
  })

  it('反复调用结果稳定(缓存不改变语义)', () => {
    for (let i = 0; i < 5; i++) {
      expect(globMatch('**/*.ts', 'src/a.ts', true)).toBe(true)
      expect(globMatch('**/*.ts', 'src/a.js', true)).toBe(false)
    }
  })

  /** 缓存满了会被整个清空 —— 清空之后语义不能变 */
  it('缓存溢出后仍然给出同样的答案', () => {
    for (let i = 0; i < 300; i++) globMatch(`*.x${String(i)}`, 'a.b', true)
    expect(globMatch('**/*.ts', 'src/a.ts', true)).toBe(true)
  })
})

describe('compileGlob · 真实用得上的模式', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**/*.test.ts', 'src/main/kernel/__tests__/a.test.ts', true],
    ['**/*.test.ts', 'src/main/kernel/a.ts', false],
    ['**/__tests__/**', 'src/main/kernel/__tests__/a.test.ts', true],
    ['src/**/*.{ts,tsx}', 'src/renderer/src/App.tsx', true],
    ['*.json', 'package.json', true],
    ['*.json', 'src/package.json', false],
    ['**/node_modules/**', 'a/node_modules/b/c.js', true],
    ['.nextcowork/skills/*/SKILL.md', '.nextcowork/skills/demo/SKILL.md', true],
    ['.nextcowork/skills/*/SKILL.md', '.nextcowork/skills/a/b/SKILL.md', false]
  ]

  for (const [pattern, path, want] of cases) {
    it(`${pattern} vs ${path} → ${String(want)}`, () => {
      expect(m(pattern, path)).toBe(want)
    })
  }
})
