import { describe, expect, it } from 'vitest'
import type { ImageTheme, Palette, ThemeToken, ThemeTokens } from '../theme'
import {
  BASE,
  COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  IMAGE_THEMES,
  RANDOM_COLOR_THEME_ID,
  THEME_TOKENS,
  chromaOf,
  extractPalette,
  hexToHsl,
  hslToHex,
  randomSeedColor,
  resolveColorTheme,
  resolveImageTheme,
  retint,
  specFromSeed,
  tokensOf
} from '../theme'

/**
 * 换色器。它有一个别处少见的性质:**期望值是可以精确写死的**,
 * 因为「选中你已经在用的那套主题」必须逐字节等于量出来的那张表。
 * 于是本文件里最重要的几条是 `toEqual`,不是「差不多」。
 *
 * 剩下的都在守 `theme.css` 文件头那三条规律 —— 它们是整套界面的地基,
 * 而换色器是唯一一个有能力在运行期把它们毁掉的东西。
 */

const APPEARANCES = ['light', 'dark'] as const

/**
 * ★ 这两张名单在源码里也有一份(`ROLE` 表)。**故意重写一遍,不 import** ——
 * 从源码 import 的话,把某个 token 从 neutral 挪到 tint 就会「测试跟着一起改口」,
 * 而这两族的划分正是本文件要钉住的东西。下面第一条用例验证两张表加起来不多不少。
 */
const NEUTRAL_TOKENS = [
  'app',
  'canvas',
  'surface',
  'chrome',
  'surface-raised',
  'surface-input',
  'surface-sunken',
  'hairline',
  'scrim'
] as const satisfies readonly ThemeToken[]

const TINT_TOKENS = [
  'tint',
  'tint-hover',
  'tint-strong',
  'surface-field',
  'border',
  'fg',
  'fg-muted',
  'fg-faint'
] as const satisfies readonly ThemeToken[]

const SPEC_TOKENS = ['icon', 'accent', 'accent-fg', 'accent-soft'] as const satisfies
  readonly ThemeToken[]

// ─── 小工具 ───

const channels = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const relLuminance = (hex: string): number => {
  const [r, g, b] = channels(hex)
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 对比度。派生出来的强调色要靠它证明「不是好看,是读得见」。 */
const contrast = (a: string, b: string): number => {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 色相差,取环上的最短弧(0–180) */
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return d > 180 ? 360 - d : d
}

const isGrey = (hex: string): boolean => {
  const [r, g, b] = channels(hex)
  return r === g && g === b
}

// ─────────────────────────────────────────────────────────────

describe('token 名单', () => {
  it('22 个,四个角色不重不漏', () => {
    const named = [...NEUTRAL_TOKENS, ...TINT_TOKENS, ...SPEC_TOKENS, 'danger']
    expect(THEME_TOKENS).toHaveLength(22)
    expect([...named].sort()).toEqual([...THEME_TOKENS].sort())
  })

  it('两张基准表都是满的,值都是规范的 #rrggbb', () => {
    for (const a of APPEARANCES) {
      for (const k of THEME_TOKENS) {
        expect(BASE[a].tokens[k], `${a}.${k}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })
})

describe('hexToHsl ⇄ hslToHex', () => {
  /**
   * ★ **本文件全部精确断言的前提。** 往返只要有一个通道差 1,
   * 下面那条「恒等」就只能写成带容差的比较,而带容差的比较证明不了
   * 「重新选中当前主题什么都不会变」——那正是用户最容易察觉的一种 bug。
   */
  it('量出来的每一个色值往返零误差', () => {
    const measured = new Set(
      APPEARANCES.flatMap((a) => THEME_TOKENS.map((k) => BASE[a].tokens[k]))
    )
    expect(measured.size).toBeGreaterThan(30)
    for (const hex of measured) {
      expect(hslToHex(hexToHsl(hex)), hex).toBe(hex)
    }
  })

  it('黑白灰:S 为 0,且往返回来还是原样', () => {
    for (const hex of ['#000000', '#ffffff', '#7e7f7e'.replace('7f', '7e')]) {
      expect(hexToHsl(hex).s).toBe(0)
      expect(hslToHex(hexToHsl(hex))).toBe(hex)
    }
  })

  it('色相越界一律绕回来,不产生非法颜色', () => {
    expect(hslToHex({ h: 380, s: 50, l: 50 })).toBe(hslToHex({ h: 20, s: 50, l: 50 }))
    expect(hslToHex({ h: -40, s: 50, l: 50 })).toBe(hslToHex({ h: 320, s: 50, l: 50 }))
  })

  /** 越界的 S / L 钳掉而不是溢出 —— `chroma` 乘数会把 S 推过 100 */
  it('S / L 越界时钳位', () => {
    expect(hslToHex({ h: 30, s: 180, l: 50 })).toBe(hslToHex({ h: 30, s: 100, l: 50 }))
    expect(hslToHex({ h: 30, s: 50, l: -10 })).toBe('#000000')
  })
})

describe('chromaOf', () => {
  /**
   * ★ 这一条是「取主色为什么不能用 HSL 饱和度」的**反例本身**:
   * `#020100` 几乎是黑的,饱和度却是 100%。
   */
  it('几乎全黑的像素:饱和度 100%,彩度只有 2', () => {
    expect(hexToHsl('#020100').s).toBeCloseTo(100)
    expect(chromaOf('#020100')).toBe(2)
  })

  it('纯灰彩度为 0,纯色为 255', () => {
    expect(chromaOf('#808080')).toBe(0)
    expect(chromaOf('#ff0000')).toBe(255)
  })
})

describe('retint · 恒等', () => {
  /**
   * ★ **本文件的头号用例。** 「墨绿」**两个外观**就是那两张采样表 ——
   * 新版参考实现深浅都是绿,所以恒等出口归同一套主题了(旧版深色是暖橙,
   * 那时的出口是「Claude」)。它们必须**逐字节**还原 —— 不是「看不出差别」,
   * 是 `toEqual`。这一条一红,说明换色器已经在悄悄改写参考实现的配色了。
   */
  it('墨绿 · 浅色 = 采样表原样', () => {
    const t = COLOR_THEMES.find((x) => x.id === DEFAULT_COLOR_THEME_ID)
    expect(t).toBeDefined()
    expect(retint(BASE.light, t!.light)).toEqual(BASE.light.tokens)
  })

  it('墨绿 · 深色 = 采样表原样', () => {
    const t = COLOR_THEMES.find((x) => x.id === DEFAULT_COLOR_THEME_ID)
    expect(t).toBeDefined()
    expect(retint(BASE.dark, t!.dark)).toEqual(BASE.dark.tokens)
  })

  /**
   * 「Claude」不再是恒等出口,但它**必须还是橙的** —— 它的深色是把旧
   * `BASE.dark` 的恒等声明搬过来当普通主题用的,搬错了会静悄悄变成绿。
   */
  it('Claude · 深色仍然是暖橙,不是采样表', () => {
    const t = COLOR_THEMES.find((x) => x.id === 'claude')
    expect(t).toBeDefined()
    const out = retint(BASE.dark, t!.dark)
    expect(out.accent).toBe('#df7e45')
    expect(out).not.toEqual(BASE.dark.tokens)
    // 结构灰被拧回冷灰(旧版量出来的 H≈190),不再是新版的绿灰 H≈153
    expect(hexToHsl(out.canvas).h).toBeGreaterThan(170)
    expect(hexToHsl(out.canvas).h).toBeLessThan(215)
  })

  it('经 tokensOf 走一遍也一样', () => {
    expect(tokensOf('light', DEFAULT_COLOR_THEME_ID, 0, null)).toEqual(BASE.light.tokens)
    expect(tokensOf('dark', DEFAULT_COLOR_THEME_ID, 0, null)).toEqual(BASE.dark.tokens)
  })
})

describe('retint · 不许动明度结构', () => {
  /**
   * ★ 四层底色的相对明暗全部编码在 L 上。换色器动了 L,整套界面的层次立刻塌掉,
   * 而它在截图上不一定看得出来 —— 所以必须有这一条。
   *
   * 容差 0.4 个百分点:8 位量化本身就是 1/255 ≈ 0.39%,比它还小的偏差
   * 在颜色上是不存在的。
   */
  it('每套主题、每个外观、每个非 spec token 的 L 都原样保留', () => {
    for (const theme of COLOR_THEMES) {
      for (const a of APPEARANCES) {
        const out = retint(BASE[a], theme[a])
        for (const k of [...NEUTRAL_TOKENS, ...TINT_TOKENS]) {
          const before = hexToHsl(BASE[a].tokens[k]).l
          const after = hexToHsl(out[k]).l
          expect(Math.abs(after - before), `${theme.id}/${a}/${k}`).toBeLessThanOrEqual(0.4)
        }
      }
    }
  })

  /**
   * ★ **旧用例断言的是 `app > chrome > canvas`,新量测把它推翻了。**
   * 那时深色的 chrome 和 surface 同值(#3d4041),chrome 夹在中间;新版参考实现
   * 把外层 Tab 条**单独提到最亮**,四层变成 canvas < surface < app < chrome。
   * 浅色是镜像的(chrome 最暗),所以两个外观都得测,断言写成
   * 「chrome 站在离 canvas 最远的那一端」而不是写死方向 —— 见 `theme.css` §1。
   */
  it('四层底色的高低关系在每套主题、每个外观下都还在', () => {
    for (const theme of COLOR_THEMES) {
      for (const a of APPEARANCES) {
        const t = retint(BASE[a], theme[a])
        const l = (k: ThemeToken): number => hexToHsl(t[k]).l
        const order = a === 'dark' ? 1 : -1
        const rank = (k: ThemeToken): number => order * l(k)
        // canvas 是极值,chrome 站在最远的那一端
        expect(rank('surface'), `${theme.id}/${a}`).toBeGreaterThan(rank('canvas'))
        expect(rank('app'), `${theme.id}/${a}`).toBeGreaterThan(rank('surface'))
        expect(rank('chrome'), `${theme.id}/${a}`).toBeGreaterThan(rank('app'))
      }
    }
  })

  it('按下的图标按钮比外层 Tab 条更靠画布那一端', () => {
    for (const theme of COLOR_THEMES) {
      const t = retint(BASE.dark, theme.dark)
      const l = (k: ThemeToken): number => hexToHsl(t[k]).l
      expect(l('surface-sunken'), theme.id).toBeLessThan(l('chrome'))
    }
  })
})

describe('retint · 两族色相各走各的', () => {
  /**
   * ★ 这是拒绝「整体旋转色相」那个方案的用例。
   *
   * 用合成色板而不是采样色板:采样值的彩度只有 3–10,8 位量化下色相的
   * 分辨率是几十度,精确断言在上面根本立不住。合成一套高彩度的,
   * 增量平移这件事就能一度不差地验出来。
   */
  const SYNTH_NEUTRAL = 200
  const SYNTH_TINT = 20

  const synth: Palette = (() => {
    const tokens = {} as ThemeTokens
    THEME_TOKENS.forEach((k, i) => {
      const neutral = (NEUTRAL_TOKENS as readonly string[]).includes(k)
      const base = neutral ? SYNTH_NEUTRAL : SYNTH_TINT
      // 每个 token 相对家族基准都有自己的一点偏移 —— 那正是要被保住的东西
      tokens[k] = hslToHex({ h: base + (i - 10), s: 70, l: 30 + i })
    })
    return { tokens, hue: { neutral: SYNTH_NEUTRAL, tint: SYNTH_TINT } }
  })()

  const spec = {
    neutral: 300,
    tint: 180,
    chroma: 1,
    icon: '#111111',
    accent: '#222222',
    accentFg: '#333333',
    accentSoft: '#444444'
  }

  it('结构族整体平移到目标色相,每个 token 自己的偏移一度不差地留着', () => {
    const out = retint(synth, spec)
    for (const k of NEUTRAL_TOKENS) {
      const delta = hexToHsl(out[k]).h - hexToHsl(synth.tokens[k]).h
      expect(hueGap(delta, spec.neutral - SYNTH_NEUTRAL), k).toBeLessThan(0.5)
    }
  })

  it('交互族平移的是另一个量 —— 两族不共用一个旋转', () => {
    const out = retint(synth, spec)
    for (const k of TINT_TOKENS) {
      const delta = hexToHsl(out[k]).h - hexToHsl(synth.tokens[k]).h
      expect(hueGap(delta, spec.tint - SYNTH_TINT), k).toBeLessThan(0.5)
    }
    // 两个平移量差着 80°,不是同一个数
    expect(hueGap(spec.neutral - SYNTH_NEUTRAL, spec.tint - SYNTH_TINT)).toBeGreaterThan(50)
  })

  /**
   * ★ 「奢华」是全表唯一一套结构与强调**不同色系**的(紫底 + 鎏金)。
   * 它同时也是「整体旋转」方案唯一表达不出来的那一套 —— 留着当活证据。
   */
  it('奢华 · 深色:底是紫的、悬停是金的,两者隔着大半个色环', () => {
    const t = COLOR_THEMES.find((x) => x.id === 'opulent')
    expect(t).toBeDefined()
    expect(hueGap(t!.dark.neutral, t!.dark.tint)).toBeGreaterThan(90)
  })
})

describe('retint · 彩度乘数', () => {
  it('极简:结构与交互态全部变成纯灰,一个彩色像素都不剩', () => {
    const t = COLOR_THEMES.find((x) => x.id === 'minimal')
    expect(t).toBeDefined()
    for (const a of APPEARANCES) {
      const out = retint(BASE[a], t![a])
      for (const k of [...NEUTRAL_TOKENS, ...TINT_TOKENS]) {
        expect(isGrey(out[k]), `${a}/${k} = ${out[k]}`).toBe(true)
      }
    }
  })

  /** ★ 去色**不包括** danger —— 极简那套留着红色警示正是这条的产物 */
  it('极简下 danger 仍然是红的', () => {
    const t = COLOR_THEMES.find((x) => x.id === 'minimal')
    const out = retint(BASE.light, t!.light)
    expect(out.danger).toBe(BASE.light.tokens.danger)
    expect(isGrey(out.danger)).toBe(false)
  })

  it('danger 在每套主题、每个外观下都原样不动', () => {
    for (const theme of COLOR_THEMES) {
      for (const a of APPEARANCES) {
        expect(retint(BASE[a], theme[a]).danger, `${theme.id}/${a}`).toBe(BASE[a].tokens.danger)
      }
    }
  })
})

describe('retint · 无彩色 token 自保护', () => {
  /**
   * 浅色的输入框是整个界面唯一的纯白,深色的遮罩是纯黑。它们的 S 已经是 0,
   * 乘任何 chroma、平移任何色相都还是原来那个 —— 不需要额外分支,
   * 但**必须有用例钉住**,否则哪天有人给 retint 加个「最低彩度」就悄悄破了。
   */
  it('浅色输入框恒为纯白,深色遮罩恒为纯黑', () => {
    for (const theme of COLOR_THEMES) {
      const l = retint(BASE.light, theme.light)
      expect(l['surface-input'], theme.id).toBe('#ffffff')
      expect(l['surface-field'], theme.id).toBe('#ffffff')
      expect(retint(BASE.dark, theme.dark).scrim, theme.id).toBe('#000000')
    }
  })
})

describe('派生出来的强调色读得见', () => {
  /**
   * ★ `specFromSeed` 里那几个 L 档位是按对比度反推的,不是挑好看的。
   * 没有这一条,「上传一张浅色的图」会得到一个几乎看不见的强调色 ——
   * 而那正是自定义主题最容易翻车的地方。
   */
  const SEEDS = [...IMAGE_THEMES.map((t) => t.seed), '#ff0000', '#00ff00', '#0000ff', '#888888']

  it('深色:强调色 vs 画布 ≥ 3.5:1', () => {
    for (const seed of SEEDS) {
      const t = retint(BASE.dark, specFromSeed(seed, 'dark'))
      expect(contrast(t.accent, t.canvas), seed).toBeGreaterThanOrEqual(3.5)
    }
  })

  it('浅色:强调色 vs 画布 ≥ 5:1', () => {
    for (const seed of SEEDS) {
      const t = retint(BASE.light, specFromSeed(seed, 'light'))
      expect(contrast(t.accent, t.canvas), seed).toBeGreaterThanOrEqual(5)
    }
  })

  it('强调色上的前景 ≥ 4.5:1', () => {
    for (const seed of SEEDS) {
      for (const a of APPEARANCES) {
        const t = retint(BASE[a], specFromSeed(seed, a))
        expect(contrast(t['accent-fg'], t.accent), `${seed}/${a}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('内置的六套颜色主题同样达标', () => {
    for (const theme of COLOR_THEMES) {
      for (const a of APPEARANCES) {
        const t = retint(BASE[a], theme[a])
        expect(contrast(t.accent, t.canvas), `${theme.id}/${a}`).toBeGreaterThanOrEqual(3.5)
        expect(contrast(t['accent-fg'], t.accent), `${theme.id}/${a}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  /**
   * 反过来的一条:`accent-soft` 是正文里的装饰性小图标,参考实现量出来
   * 只有 1.98:1(深)/ 3.08:1(浅)。**它不该达标** —— 把它推到 4.5:1
   * 会让思考/工具那几个小图标喧宾夺主。
   */
  it('accent-soft 刻意是低对比的装饰色,不参与达标', () => {
    for (const seed of ['#b5714a', '#3f8a86']) {
      for (const a of APPEARANCES) {
        const t = retint(BASE[a], specFromSeed(seed, a))
        expect(contrast(t['accent-soft'], t.canvas), `${seed}/${a}`).toBeLessThan(4.5)
      }
    }
  })

  /**
   * ★ **旧用例断言「深色下 icon 与 accent 同值」,新量测把它推翻了。**
   * 那条只在参考实现 v1.1.15(暖橙)成立 —— 新版深色量出来 icon #cfcfcf、
   * accent #36d285,两者分开了。现在**两个外观**都是中性灰:
   * icon = 「这是个可点的东西」,accent = 「这个是激活的」(`theme.css` §3)。
   */
  it('静息图标在两个外观下都是中性灰,不是强调色', () => {
    for (const seed of ['#b5714a', '#5b7fa8']) {
      for (const a of APPEARANCES) {
        const spec = specFromSeed(seed, a)
        expect(chromaOf(spec.icon), `${seed}/${a}`).toBeLessThan(12)
        expect(spec.icon, `${seed}/${a}`).not.toBe(spec.accent)
      }
    }
  })
})

describe('resolveColorTheme', () => {
  it('按 id 取到的就是表里那一套', () => {
    for (const t of COLOR_THEMES) {
      if (t.id === RANDOM_COLOR_THEME_ID) continue
      expect(resolveColorTheme(t.id, 0)).toBe(t)
    }
  })

  /** id 来自设置,而设置将来会从磁盘读回来 —— 不认识的 id 落回默认,不抛 */
  it('不认识的 id 落回默认,不抛', () => {
    expect(resolveColorTheme('这套主题不存在', 0).id).toBe(DEFAULT_COLOR_THEME_ID)
    expect(resolveColorTheme('', 7).id).toBe(DEFAULT_COLOR_THEME_ID)
  })

  /**
   * ★ 「随机」是**种子的纯函数**。不是这样的话,每次重渲染都会换一次色,
   * 而且重启之后回不到用户掷出来的那一套。
   */
  it('随机:同一个种子永远同一套', () => {
    expect(tokensOf('dark', RANDOM_COLOR_THEME_ID, 42, null)).toEqual(
      tokensOf('dark', RANDOM_COLOR_THEME_ID, 42, null)
    )
  })

  /**
   * ★ 门槛写 60 而不是 20:实现走的是黄金角,相邻两次重掷**必然**隔着 137.5°。
   * 写成一个宽松的门槛就退化成「哈希大概率不撞」——那正是这里曾经错过的地方
   * (种子 7→8 的色相差正好 20°)。
   */
  it('随机:相邻的种子给出差得远的色相 —— 重掷要看得出来', () => {
    for (let seed = 0; seed < 8; seed++) {
      const a = hexToHsl(randomSeedColor(seed)).h
      const b = hexToHsl(randomSeedColor(seed + 1)).h
      expect(hueGap(a, b), `${seed}→${seed + 1}`).toBeGreaterThan(60)
    }
  })

  it('随机掷出来的每一套也满足对比度要求', () => {
    for (let seed = 0; seed < 30; seed++) {
      for (const a of APPEARANCES) {
        const t = tokensOf(a, RANDOM_COLOR_THEME_ID, seed, null)
        expect(contrast(t.accent, t.canvas), `${seed}/${a}`).toBeGreaterThanOrEqual(3.5)
        expect(contrast(t['accent-fg'], t.accent), `${seed}/${a}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('tokensOf · 图片主题盖过颜色主题', () => {
  /**
   * ★ 两者都要改整套 token,允许叠加的话「我选了墨绿,界面怎么是橙的」
   * 会变成一个说不清的问题。选了图 = 颜色主题那一栏不生效。
   */
  it('给了图就不看颜色主题', () => {
    const withImage = tokensOf('dark', 'minimal', 0, { seed: '#b5714a' })
    expect(withImage).toEqual(tokensOf('dark', 'celadon', 99, { seed: '#b5714a' }))
    expect(withImage).not.toEqual(tokensOf('dark', 'minimal', 0, null))
  })

  /**
   * 反过来的一半:取消选图,回到的是**当时选着的那一套颜色主题**,
   * 不是回到默认。写成「等于采样表」的话就只覆盖了默认那一套 ——
   * 而「取消选图之后我的墨绿变成 Claude 了」正是这里会出的错。
   */
  it('取消选图就回到当时选着的那套颜色主题', () => {
    for (const id of ['claude', 'celadon', 'minimal']) {
      const theme = COLOR_THEMES.find((x) => x.id === id)
      expect(theme, id).toBeDefined()
      const back = tokensOf('dark', id, 0, null)
      expect(back, id).toEqual(retint(BASE.dark, theme!.dark))
      expect(back, id).not.toEqual(tokensOf('dark', id, 0, { seed: '#b5714a' }))
    }
    // 默认那一套额外多一条:它回落到的正是采样表原样
    expect(tokensOf('dark', DEFAULT_COLOR_THEME_ID, 0, null)).toEqual(BASE.dark.tokens)
  })

  it('内置的六张图各自给出一套不同的界面', () => {
    const seen = new Set(
      IMAGE_THEMES.map((t) => JSON.stringify(tokensOf('dark', 'claude', 0, { seed: t.seed })))
    )
    expect(seen.size).toBe(IMAGE_THEMES.length)
  })
})

describe('extractPalette', () => {
  const img = (colors: readonly (readonly [number, number, number])[]): Uint8ClampedArray => {
    const px: number[] = []
    for (const [r, g, b] of colors) px.push(r, g, b, 255)
    return new Uint8ClampedArray(px)
  }
  const solid = (
    c: readonly [number, number, number],
    n: number
  ): (readonly [number, number, number])[] => Array.from({ length: n }, () => c)

  it('纯色图:第 0 个就是那个颜色', () => {
    const out = extractPalette(img(solid([181, 113, 74], 200)))
    const [r, g, b] = channels(out[0] ?? '#000000')
    expect(Math.abs(r - 181)).toBeLessThanOrEqual(4)
    expect(Math.abs(g - 113)).toBeLessThanOrEqual(4)
    expect(Math.abs(b - 74)).toBeLessThanOrEqual(4)
  })

  it('总是返回 count 个', () => {
    expect(extractPalette(img(solid([181, 113, 74], 40)))).toHaveLength(4)
    expect(extractPalette(img(solid([181, 113, 74], 40)), 6)).toHaveLength(6)
  })

  /**
   * ★ **按彩度加权而不是按面积**的那一条。九成像素是灰的、一成是鲜橙,
   * 取出来的主色必须是橙 —— 人对这张图的颜色印象就是橙。
   * 按面积聚类会稳定地返回那片灰。
   */
  it('少量鲜艳色压过大片灰', () => {
    const out = extractPalette(
      img([...solid([128, 128, 128], 180), ...solid([230, 120, 40], 20)])
    )
    expect(chromaOf(out[0] ?? '#808080')).toBeGreaterThan(80)
  })

  /**
   * ★ 圆周平均 + `wrapHue` 的回归:落在 345–360 那一桶的红色,
   * `atan2` 给出的是**负角度**。不绕回来的话 `hslToHex` 会拿到一个负色相 ——
   * 表现是一张红色的图取出一个青色的主色。
   */
  it('色相环末端的红不会翻到对面去', () => {
    const out = extractPalette(img([...solid([255, 60, 78], 60), ...solid([250, 40, 55], 60)]))
    const [r, g, b] = channels(out[0] ?? '#000000')
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    const h = hexToHsl(out[0] ?? '#000000').h
    expect(hueGap(h, 355)).toBeLessThan(20)
  })

  it('灰度图:给出一串灰,不凭空造颜色', () => {
    const out = extractPalette(img([...solid([40, 40, 40], 50), ...solid([200, 200, 200], 50)]))
    expect(out).toHaveLength(4)
    for (const hex of out) expect(isGrey(hex), hex).toBe(true)
  })

  it('全透明 / 空图不炸', () => {
    expect(extractPalette(new Uint8ClampedArray([]))).toHaveLength(4)
    expect(extractPalette(new Uint8ClampedArray([255, 0, 0, 0]))).toHaveLength(4)
  })

  /** 取出来的主色喂给 specFromSeed 之后,整套仍然达标 —— 这才是它真正的下游 */
  it('取出来的色能直接当种子用', () => {
    const seed = extractPalette(img(solid([181, 113, 74], 100)))[0] ?? '#000000'
    for (const a of APPEARANCES) {
      const t = retint(BASE[a], specFromSeed(seed, a))
      expect(contrast(t.accent, t.canvas), a).toBeGreaterThanOrEqual(3.5)
    }
  })
})

describe('resolveImageTheme', () => {
  it('按 id 取到内置的那张', () => {
    for (const t of IMAGE_THEMES) expect(resolveImageTheme(t.id)).toBe(t)
  })

  it('没选图就是 null', () => {
    expect(resolveImageTheme(null)).toBeNull()
  })

  /**
   * ★ 悬空 id 落回 null(= 走颜色主题),**不是**落回某一张内置图。
   * 用户删掉自己上传的那张图之后,设置里存着的就是这么一个 id ——
   * 此时界面该回到他选着的颜色主题,而不是莫名其妙变成「雾林深境」。
   */
  it('认不出来的 id 当作没选图', () => {
    expect(resolveImageTheme('这张图已经被删了')).toBeNull()
    expect(resolveImageTheme('')).toBeNull()
  })

  it('上传的那些也能取到,但内置的优先', () => {
    const mine: ImageTheme = {
      id: 'my-photo',
      name: '我的图',
      seed: '#123456',
      source: { kind: 'uploaded', assetId: 'a1' }
    }
    const shadow: ImageTheme = { ...mine, id: IMAGE_THEMES[0]!.id }
    expect(resolveImageTheme('my-photo', [mine])).toBe(mine)
    // 同名的上传图顶不掉内置的 —— 内置 id 是我们自己发的常量
    expect(resolveImageTheme(shadow.id, [shadow])).toBe(IMAGE_THEMES[0])
  })
})

describe('内置数据表', () => {
  it('颜色主题 id 唯一,且含随机与默认', () => {
    const ids = COLOR_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(RANDOM_COLOR_THEME_ID)
    expect(ids).toContain(DEFAULT_COLOR_THEME_ID)
  })

  it('图片主题 id 唯一,种子都是规范色值,内置的都带渐变配方', () => {
    const ids = IMAGE_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of IMAGE_THEMES) {
      expect(t.seed, t.id).toMatch(/^#[0-9a-f]{6}$/)
      expect(t.source.kind).toBe('builtin')
      if (t.source.kind === 'builtin') expect(t.source.css.length, t.id).toBeGreaterThan(20)
    }
  })
})
