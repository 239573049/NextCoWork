import { describe, expect, it } from 'vitest'
import { FM_LIMITS, fmBool, fmList, fmString, parseFrontmatter } from '../frontmatter'

/**
 * 前置块解析器的测试。
 *
 * 这个文件里有两类用例,分开看:
 *
 * - **能力**:支持的子集确实能解析出来。
 * - **防线**:不可信输入(SKILL.md 来自 zip / git)的那几条 —— 原型污染、
 *   尺寸闸门、控制字符。这几条不是「边界情况」,它们是这个模块**存在的理由**
 *   (否则直接 `import yaml from 'yaml'` 就完了)。
 */

describe('parseFrontmatter · 基本形状', () => {
  it('解析出键值和正文', () => {
    const fm = parseFrontmatter('---\nname: commit\ndescription: 写提交信息\n---\n正文第一行\n正文第二行')
    expect(fm.data.name).toBe('commit')
    expect(fm.data.description).toBe('写提交信息')
    expect(fm.body).toBe('正文第一行\n正文第二行')
  })

  it('... 也能收尾', () => {
    const fm = parseFrontmatter('---\nname: x\n...\nbody')
    expect(fm.data.name).toBe('x')
    expect(fm.body).toBe('body')
  })

  it('值里的冒号只按第一个分割', () => {
    const fm = parseFrontmatter('---\ndescription: 用法:先读再写\n---\n')
    expect(fm.data.description).toBe('用法:先读再写')
  })

  it('★ 行内 # 不当注释剥掉 —— CC 自己的 description 里就带 #', () => {
    const fm = parseFrontmatter('---\ndescription: 以 # 开头的行是注释\n---\n')
    expect(fm.data.description).toBe('以 # 开头的行是注释')
  })

  it('整行 # 是注释,静默跳过', () => {
    const fm = parseFrontmatter('---\n# 这是注释\nname: x\n---\n')
    expect(fm.data.name).toBe('x')
    expect(fm.skipped).toHaveLength(0)
  })

  it('空行不影响解析', () => {
    const fm = parseFrontmatter('---\nname: x\n\ndescription: y\n---\n')
    expect(fm.data.name).toBe('x')
    expect(fm.data.description).toBe('y')
  })
})

describe('parseFrontmatter · 引号', () => {
  it('单引号和双引号都去掉', () => {
    const fm = parseFrontmatter(`---\na: 'hello'\nb: "world"\n---\n`)
    expect(fm.data.a).toBe('hello')
    expect(fm.data.b).toBe('world')
  })

  it("单引号里的 '' 是一个字面单引号", () => {
    const fm = parseFrontmatter(`---\na: 'it''s'\n---\n`)
    expect(fm.data.a).toBe("it's")
  })

  it('双引号里的 \\n 变成真换行', () => {
    const fm = parseFrontmatter('---\na: "x\\ny"\n---\n')
    expect(fm.data.a).toBe('x\ny')
  })

  it('引号不成对时原样保留,不猜', () => {
    const fm = parseFrontmatter(`---\na: 'unterminated\n---\n`)
    expect(fm.data.a).toBe("'unterminated")
  })
})

describe('parseFrontmatter · 列表', () => {
  it('流式序列 [a, b]', () => {
    const fm = parseFrontmatter('---\ntools: [Read, Grep, Glob]\n---\n')
    expect(fm.data.tools).toEqual(['Read', 'Grep', 'Glob'])
  })

  it('流式序列里的引号也去掉', () => {
    const fm = parseFrontmatter(`---\ntools: ['Read', "Grep"]\n---\n`)
    expect(fm.data.tools).toEqual(['Read', 'Grep'])
  })

  it('块式序列', () => {
    const fm = parseFrontmatter('---\ntools:\n  - Read\n  - Grep\n---\n')
    expect(fm.data.tools).toEqual(['Read', 'Grep'])
  })

  it('块式序列不缩进也认', () => {
    const fm = parseFrontmatter('---\ntools:\n- Read\n- Grep\n---\n')
    expect(fm.data.tools).toEqual(['Read', 'Grep'])
  })

  it('块式序列之后还能接别的键', () => {
    const fm = parseFrontmatter('---\ntools:\n  - Read\nname: x\n---\n')
    expect(fm.data.tools).toEqual(['Read'])
    expect(fm.data.name).toBe('x')
  })

  it('没有对应键的顶层列表项被记下来', () => {
    const fm = parseFrontmatter('---\n- 孤儿\n---\n')
    expect(fm.skipped.join()).toContain('列表项')
  })

  it('空列表值保持空串,不是 undefined', () => {
    const fm = parseFrontmatter('---\ntools:\n---\n')
    expect(fm.data.tools).toBe('')
  })
})

describe('parseFrontmatter · 不支持的语法照实记下', () => {
  it('嵌套 map 被跳过', () => {
    const fm = parseFrontmatter('---\nname: x\nnested:\n  a: 1\n---\n')
    expect(fm.data.name).toBe('x')
    expect(fm.data).not.toHaveProperty('a')
    expect(fm.skipped.join()).toContain('嵌套')
  })

  it('锚点和别名被跳过', () => {
    const fm = parseFrontmatter('---\na: &anchor v\nb: *anchor\n---\n')
    expect(fm.skipped.filter((s) => s.includes('锚点'))).toHaveLength(2)
    expect(fm.data).not.toHaveProperty('a')
  })

  it('块标量被跳过,连同它后面的缩进行', () => {
    const fm = parseFrontmatter('---\ntext: |\n  line1\n  line2\nname: x\n---\n')
    expect(fm.skipped.join()).toContain('块标量')
    expect(fm.data.name).toBe('x')
    // ★ 缩进的续行不能被当成「嵌套 map」再报一次,更不能被当成键值解析出来
    expect(fm.data).not.toHaveProperty('line1')
  })

  it('不合法的键名被跳过', () => {
    const fm = parseFrontmatter('---\n9bad: v\nname: x\n---\n')
    expect(fm.data).not.toHaveProperty('9bad')
    expect(fm.data.name).toBe('x')
    expect(fm.skipped.join()).toContain('键名')
  })

  it('不是键值形状的行被跳过', () => {
    const fm = parseFrontmatter('---\n随便一行字\nname: x\n---\n')
    expect(fm.data.name).toBe('x')
    expect(fm.skipped.join()).toContain('键: 值')
  })
})

describe('parseFrontmatter · 没有前置块', () => {
  it('首行不是 --- 时,原文就是正文', () => {
    const src = '# 标题\n内容'
    const fm = parseFrontmatter(src)
    expect(fm.body).toBe(src)
    expect(Object.keys(fm.data)).toHaveLength(0)
  })

  it('空字符串不炸', () => {
    expect(parseFrontmatter('').body).toBe('')
  })

  /** ★ 吞掉正文的话,Skill 会变成「有 frontmatter 但没内容」—— 加载器判定它有效,模型收到一份空指令 */
  it('★ 没有结束标记时整块按正文处理,不把整个文件吞成前置块', () => {
    const src = '---\nname: x\n还有很多正文'
    const fm = parseFrontmatter(src)
    expect(fm.body).toBe(src)
    expect(fm.data).not.toHaveProperty('name')
    expect(fm.skipped.join()).toContain('结束标记')
  })

  it('★ 任何输入都不抛异常', () => {
    const nasty = [
      '---',
      '---\n',
      '---\n---',
      '---\n:\n---\n',
      '---\n: v\n---\n',
      '---\na:\n- \n---\n',
      '---\n[\n---\n',
      '-'.repeat(10_000),
      '---\n' + 'a: b\n'.repeat(5000) + '---\n'
    ]
    for (const s of nasty) expect(() => parseFrontmatter(s), JSON.stringify(s.slice(0, 20))).not.toThrow()
  })
})

describe('parseFrontmatter · BOM 与 CRLF', () => {
  it('BOM 不影响首行判断', () => {
    const fm = parseFrontmatter('\uFEFF---\nname: x\n---\nbody')
    expect(fm.data.name).toBe('x')
    expect(fm.body).toBe('body')
  })

  it('CRLF 的文件正常解析,且值里不留 \\r', () => {
    const fm = parseFrontmatter('---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n')
    expect(fm.data.name).toBe('x')
    expect(fm.data.description).toBe('y')
    expect(fm.body).not.toContain('\r')
  })
})

// ────────────────────────── 防线 ──────────────────────────

describe('★ parseFrontmatter · 原型污染', () => {
  /**
   * ★ 这一条是这个模块存在的最直接理由。
   *
   * 一份从 git 装来的 SKILL.md 里写一行 `__proto__: polluted` 是零成本的。
   * 只靠 `Object.create(null)` 不够 —— `data` 会被下游拷进普通对象、展开进
   * 字面量、`JSON.parse(JSON.stringify(...))` 转一圈,只要中途落到一个
   * **有原型**的对象上,赋值就真的污染了全局。所以这三个键要显式拒绝。
   */
  it('★ __proto__ 不进 data,也没有污染任何东西', () => {
    const fm = parseFrontmatter('---\n__proto__: polluted\nname: x\n---\n')
    expect(fm.data).not.toHaveProperty('__proto__')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
    // 正常的键不受影响
    expect(fm.data.name).toBe('x')
    expect(fm.skipped.join()).toContain('安全')
  })

  it('★ constructor 与 prototype 一样拒绝', () => {
    const fm = parseFrontmatter('---\nconstructor: x\nprototype: y\n---\n')
    expect(fm.data).not.toHaveProperty('constructor')
    expect(fm.data).not.toHaveProperty('prototype')
    expect(fm.skipped).toHaveLength(2)
  })

  it('★ 把 data 拷进普通对象之后也污染不了', () => {
    const fm = parseFrontmatter('---\n__proto__: polluted\n---\n')
    const copy: Record<string, unknown> = { ...fm.data }
    for (const [k, v] of Object.entries(fm.data)) copy[k] = v
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('data 本身没有原型 —— 双保险', () => {
    const fm = parseFrontmatter('---\nname: x\n---\n')
    expect(Object.getPrototypeOf(fm.data)).toBeNull()
  })
})

describe('★ parseFrontmatter · 尺寸闸门', () => {
  it(`超过 ${String(FM_LIMITS.FM_BLOCK_MAX / 1024)}KB 的前置块只解析前面一部分,正文位置仍然对`, () => {
    const filler = Array.from({ length: 400 }, (_, i) => `k${String(i)}: ${'v'.repeat(40)}`).join('\n')
    const fm = parseFrontmatter(`---\nname: first\n${filler}\nlast: 尾巴\n---\n真正的正文`)
    expect(fm.data.name).toBe('first')
    expect(fm.data).not.toHaveProperty('last')
    expect(fm.skipped.join()).toContain('KB')
    // ★ 正文没有被前置块吃掉
    expect(fm.body).toBe('真正的正文')
  })

  it(`键的数量封顶在 ${String(FM_LIMITS.FM_KEYS_MAX)} 个`, () => {
    const many = Array.from({ length: 100 }, (_, i) => `k${String(i)}: v`).join('\n')
    const fm = parseFrontmatter(`---\n${many}\n---\n`)
    expect(Object.keys(fm.data).length).toBeLessThanOrEqual(FM_LIMITS.FM_KEYS_MAX)
    expect(fm.skipped.join()).toContain('键的数量')
  })

  it(`单个值封顶在 ${String(FM_LIMITS.FM_VALUE_MAX / 1024)}KB`, () => {
    // 5000 字符:超过值上限(4KB),但整块仍在块上限(8KB)以内 —— 这样触发的是值那道闸
    const fm = parseFrontmatter(`---\ndescription: ${'x'.repeat(5000)}\n---\n`)
    expect(String(fm.data.description)).toHaveLength(FM_LIMITS.FM_VALUE_MAX)
    expect(fm.skipped.join()).toContain('截断')
  })

  /**
   * ★ 两道闸是有先后的,这一条把先后钉住。
   *
   * 一个 20KB 的单行值先撞上**块**上限(8KB),于是那一行整个不解析 ——
   * 而不是被截成 4KB 存进去。写成后者也说得通,但两种行为不能同时成立,
   * 而「块预算先生效」才和「前置块整体有个头」这个意图一致。
   */
  it('★ 单行就撑爆块预算时,那一行整个不解析(块闸在值闸之前)', () => {
    const fm = parseFrontmatter(`---\ndescription: ${'x'.repeat(20_000)}\nname: x\n---\n正文`)
    expect(fm.data).not.toHaveProperty('description')
    expect(fm.skipped.join()).toContain('KB')
    expect(fm.body).toBe('正文')
  })

  it(`列表封顶在 ${String(FM_LIMITS.FM_LIST_MAX)} 项`, () => {
    const items = Array.from({ length: 200 }, (_, i) => `- t${String(i)}`).join('\n')
    const fm = parseFrontmatter(`---\ntools:\n${items}\n---\n`)
    expect(fm.data.tools).toHaveLength(FM_LIMITS.FM_LIST_MAX)
  })

  it('没有结束标记的巨大文件也很快返回', () => {
    const t0 = Date.now()
    parseFrontmatter(`---\n${'a: b\n'.repeat(200_000)}`)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('★ parseFrontmatter · 控制字符', () => {
  /**
   * ★ description 直接进系统提示词。一个 ANSI 转义或 NUL 落在里面之后,
   * 谁也说不清下游(日志、终端、转录渲染)会拿它做什么。
   * 这里用 `String.fromCharCode` 造字符,不在源码里写字面控制字符 ——
   * 后者在编辑器和 diff 里都是隐形的。
   */
  it('★ 值里的控制字符被削掉', () => {
    const ESC = String.fromCharCode(27)
    const NUL = String.fromCharCode(0)
    const fm = parseFrontmatter(`---\ndescription: 前${ESC}[31m红${NUL}后\n---\n`)
    const d = String(fm.data.description)
    expect(d).not.toContain(ESC)
    expect(d).not.toContain(NUL)
    expect(d).toContain('红')
  })

  it('列表项里的控制字符也削', () => {
    const NUL = String.fromCharCode(0)
    const fm = parseFrontmatter(`---\ntools: [Re${NUL}ad]\n---\n`)
    expect((fm.data.tools as string[])[0]).toBe('Read')
  })
})

// ────────────────────────── 取值助手 ──────────────────────────

describe('fmString', () => {
  const fm = parseFrontmatter('---\na: hello\nb: [x]\nc: "   "\n---\n')

  it('取到字符串', () => {
    expect(fmString(fm, 'a')).toBe('hello')
  })

  it('★ 写成列表时返回 undefined —— 拼起来是猜,猜错比缺失更难查', () => {
    expect(fmString(fm, 'b')).toBeUndefined()
  })

  it('全是空白等于没有', () => {
    expect(fmString(fm, 'c')).toBeUndefined()
  })

  it('不存在的键返回 undefined', () => {
    expect(fmString(fm, 'nope')).toBeUndefined()
  })
})

describe('fmList', () => {
  /**
   * ★ 这一组钉的是「两种写法必须合流」。
   *
   * 用户会把 Claude Code 的 agent 文件原样粘过来,里面写的是
   * `tools: Read, Grep, Glob`(一个裸标量);而 `allowed-tools` 更常写成
   * `[Read, Grep]`。两种都得认成同一个东西 —— 不然子代理会带着
   * 一个叫 "Read, Grep, Glob" 的工具名去查表,查不到,然后带着空工具表跑起来。
   */
  it('★ YAML 数组与逗号分隔字符串给出同一个答案', () => {
    const a = parseFrontmatter('---\ntools: [Read, Grep, Glob]\n---\n')
    const b = parseFrontmatter('---\ntools: Read, Grep, Glob\n---\n')
    const c = parseFrontmatter('---\ntools:\n  - Read\n  - Grep\n  - Glob\n---\n')
    expect(fmList(a, 'tools')).toEqual(['Read', 'Grep', 'Glob'])
    expect(fmList(b, 'tools')).toEqual(fmList(a, 'tools'))
    expect(fmList(c, 'tools')).toEqual(fmList(a, 'tools'))
  })

  it('单项也是列表', () => {
    expect(fmList(parseFrontmatter('---\ntools: Read\n---\n'), 'tools')).toEqual(['Read'])
  })

  it('空值和不存在都返回 undefined —— 区分「没写」与「写了空的」不值得', () => {
    expect(fmList(parseFrontmatter('---\ntools:\n---\n'), 'tools')).toBeUndefined()
    expect(fmList(parseFrontmatter('---\na: b\n---\n'), 'tools')).toBeUndefined()
  })

  it('多余的逗号和空白被丢掉', () => {
    expect(fmList(parseFrontmatter('---\ntools: Read, , Grep,\n---\n'), 'tools')).toEqual([
      'Read',
      'Grep'
    ])
  })
})

describe('fmBool', () => {
  it('认得几种常见写法', () => {
    const fm = parseFrontmatter(
      '---\na: true\nb: false\nc: yes\nd: no\ne: TRUE\nf: on\ng: off\nh: 1\ni: 0\n---\n'
    )
    expect(fmBool(fm, 'a')).toBe(true)
    expect(fmBool(fm, 'b')).toBe(false)
    expect(fmBool(fm, 'c')).toBe(true)
    expect(fmBool(fm, 'd')).toBe(false)
    expect(fmBool(fm, 'e')).toBe(true)
    expect(fmBool(fm, 'f')).toBe(true)
    expect(fmBool(fm, 'g')).toBe(false)
    expect(fmBool(fm, 'h')).toBe(true)
    expect(fmBool(fm, 'i')).toBe(false)
  })

  it('★ 认不出返回 undefined,不当成 false', () => {
    // 当成 false 的话,`globalEnabled: maybe` 会静默变成「关闭」,
    // 而用户看到的是「我明明写了」。undefined 让调用方能选自己的默认值。
    expect(fmBool(parseFrontmatter('---\na: 随便\n---\n'), 'a')).toBeUndefined()
    expect(fmBool(parseFrontmatter('---\na: b\n---\n'), 'nope')).toBeUndefined()
  })

  it('解析时 true 仍然是字符串 —— coerce 只在 fmBool 里发生', () => {
    expect(parseFrontmatter('---\na: true\n---\n').data.a).toBe('true')
  })
})
