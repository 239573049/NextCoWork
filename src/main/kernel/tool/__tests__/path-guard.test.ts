import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PathEscapeError,
  displayPath,
  resolveAnywhere,
  resolveInWorkspace,
  toWorkspaceRelative
} from '../path-guard'

/**
 * 路径解析是方案 §9 的收口点 —— **整个应用里唯一一个把不可信路径变成真实路径的地方**。
 * 这里测的每一条都对应一种真实的手法(词法逃逸、绝对路径、软链、`/var`、大小写),
 * 而不是覆盖率。
 *
 * ★ 两个出口的分工别混:`resolveAnywhere` **报告**落点在根内还是根外,内置文件工具用它;
 * `resolveInWorkspace` 在它之上落在根外就抛,只留给「读到的东西自动进系统提示词」的那几处
 * (Skill / 子代理 / `AGENTS.md`)。所以下面「拦截」那一组仍然是有效断言。
 *
 * 用真实文件系统而不是打桩:要挡的三样里有两样(符号链接、macOS 的 `/var` →
 * `/private/var`)**只有真 realpath 才看得见**,桩掉 `fs` 就把被测的东西一起桩掉了。
 */

let base = ''
let root = ''
let outside = ''

beforeAll(() => {
  // ★ 根和「外面」是**兄弟**,不是父子 —— 父子的话逃逸测试会因为
  // 目标恰好在根的上一层而通过得太轻易,证明不了词法检查真的在跑
  base = mkdtempSync(join(tmpdir(), 'nextcowork-guard-'))
  root = join(base, 'ws')
  outside = join(base, 'outside')

  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), '')
  writeFileSync(join(outside, 'secret.txt'), 'ssh-key')

  symlinkSync(outside, join(root, 'escape'), 'dir')
  symlinkSync(join(root, 'src'), join(root, 'src-alias'), 'dir')
  // ★ 根**自己**的一个软链别名。macOS 上 `/var` → `/private/var` 天然就是这个形状,
  // 但 Linux 的 `/tmp` 不是软链,不显式建一个的话下面那条回归测试在 Linux 上是空跑的。
  symlinkSync(root, join(base, 'ws-link'), 'dir')
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('resolveInWorkspace · 放行', () => {
  it('工作区相对路径', () => {
    expect(resolveInWorkspace(root, 'src/index.ts')).toBe(
      resolveInWorkspace(root, join(root, 'src', 'index.ts'))
    )
    expect(resolveInWorkspace(root, 'src/index.ts').endsWith(join('ws', 'src', 'index.ts'))).toBe(
      true
    )
  })

  it('根本身', () => {
    expect(toWorkspaceRelative(root, resolveInWorkspace(root, '.'))).toBe('')
  })

  /**
   * ★ 目标**还不存在**必须放行,否则 `write_file` 一个新文件就永远失败。
   * 实现是「退到最深的存在的祖先再 realpath」,所以这一条同时守着那段循环。
   */
  it('还不存在的文件(写新文件的场景)', () => {
    const out = resolveInWorkspace(root, 'src/brand-new.ts')
    expect(out.endsWith(join('src', 'brand-new.ts'))).toBe(true)
  })

  it('还不存在的**多层**目录', () => {
    const out = resolveInWorkspace(root, 'nope/not/here/x.ts')
    expect(out.endsWith(join('nope', 'not', 'here', 'x.ts'))).toBe(true)
  })

  /** 词法上有 `..` 但最终仍落在根内 —— 不能一见 `..` 就拒 */
  it('绕了一圈仍在根内的 ..', () => {
    expect(resolveInWorkspace(root, 'a/b/../../src/index.ts')).toBe(
      resolveInWorkspace(root, 'src/index.ts')
    )
  })

  /** 指向根内的软链是合法的(仓库里到处都是),要区别于指向根外的那种 */
  it('指向根内的符号链接', () => {
    expect(resolveInWorkspace(root, 'src-alias/index.ts')).toBe(
      resolveInWorkspace(root, 'src/index.ts')
    )
  })

  /**
   * ★ **回归**:根落在一条软链后面时,调用方给的绝对路径必须仍然放行。
   *
   * 这里曾经错过一次,而且错得很隐蔽 —— 根被 realpath 成 `/private/var/…`,
   * 调用方手里的绝对路径还是 `/var/…`,拿这两个字符串直接比就判成了越界。
   * macOS 上 `/var` 和 `/tmp` 都是软链,用户把 `~/code` 指到外置卷也很常见;
   * 更要命的是**工作区记录里存的 `rootPath` 就是没折算过的那种**
   * (`showOpenDialog` 原样返回),所以这条路径是自家代码天天在走的。
   */
  it('根在软链后面时,未折算的绝对路径仍然放行', () => {
    const viaLink = join(base, 'ws-link', 'src', 'index.ts')
    expect(resolveInWorkspace(root, viaLink)).toBe(resolveInWorkspace(root, 'src/index.ts'))
    // 反过来也一样:拿软链当根传进来,和拿真路径当根等价
    expect(resolveInWorkspace(join(base, 'ws-link'), 'src/index.ts')).toBe(
      resolveInWorkspace(root, 'src/index.ts')
    )
  })
})

describe('resolveInWorkspace · 拦截', () => {
  it('词法逃逸 ..', () => {
    expect(() => resolveInWorkspace(root, '../outside/secret.txt')).toThrow(PathEscapeError)
    expect(() => resolveInWorkspace(root, 'src/../../outside/secret.txt')).toThrow(PathEscapeError)
    expect(() => resolveInWorkspace(root, '../../../../../../etc/passwd')).toThrow(PathEscapeError)
  })

  /**
   * ★ 模型给绝对路径时,`path.join(root, p)` 会把它当成新的根 —— 这是最容易写错的一条。
   * 绝对路径不享受任何特殊待遇,一样要落在根里面。
   */
  it('模型给出的绝对路径', () => {
    expect(() => resolveInWorkspace(root, join(outside, 'secret.txt'))).toThrow(PathEscapeError)
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(PathEscapeError)
  })

  /**
   * ★ **词法检查对这一条完全无能为力**:`<root>/escape/secret.txt` 每一段都在根里面。
   * 只有 realpath 之后才看得见它其实指到了兄弟目录。少了第二道检查,
   * 一个软链就能把整个围栏变成摆设。
   */
  it('指向根外的符号链接', () => {
    expect(() => resolveInWorkspace(root, 'escape/secret.txt')).toThrow(PathEscapeError)
    expect(() => resolveInWorkspace(root, 'escape')).toThrow(PathEscapeError)
  })

  /** 软链后面挂一个还不存在的文件 —— 写入路径上的同一个洞 */
  it('经符号链接写一个根外的新文件', () => {
    expect(() => resolveInWorkspace(root, 'escape/planted.txt')).toThrow(PathEscapeError)
  })

  /**
   * ★ **前缀相同不等于在里面。** `/tmp/x/ws-evil` 以 `/tmp/x/ws` 开头,
   * 但它是根的**兄弟**。用 `startsWith` 判包含的实现会在这里放行。
   */
  it('只是名字前缀相同的兄弟目录', () => {
    const sibling = join(base, 'wsevil')
    mkdirSync(sibling, { recursive: true })
    expect(() => resolveInWorkspace(root, sibling)).toThrow(PathEscapeError)
  })

  it('抛的是 PathEscapeError,带得上原始输入', () => {
    try {
      resolveInWorkspace(root, '../outside/secret.txt')
      expect.unreachable('本该抛')
    } catch (err) {
      expect(err).toBeInstanceOf(PathEscapeError)
      expect((err as PathEscapeError).attempted).toBe('../outside/secret.txt')
      expect((err as PathEscapeError).name).toBe('PathEscapeError')
    }
  })
})

/**
 * ★ 这一组的期望**随盘相反**,而这正是重点:折叠比较在大小写不敏感的盘上是
 * 必须的(不折叠 = 改个大小写就绕过围栏),在大小写敏感的盘上是错的
 * (折叠 = 把 `/data` 和 `/DATA` 两个不同目录当成同一个)。
 * 写成一条「大小写不敏感」会在另一半机器上悄悄错。
 *
 * 注意判据是**盘**不是平台:被测代码按平台决定折不折(macOS 一律折),
 * 但 APFS 是可以格成大小写敏感的,而 `realpathSync` 听盘的不听平台的。
 * 所以断言这边必须真的去探一下,否则这个文件在一台大小写敏感的 Mac 上会红。
 */
const VOLUME_INSENSITIVE = existsSync(tmpdir().toUpperCase())

describe('resolveInWorkspace · 大小写', () => {
  // 叶子用不存在的名字,是为了同时覆盖"写新文件"那条路径 ——
  // 大小写的折算发生在已存在的那段前缀上,叶子存不存在都一样
  const shouted = (): string => `${root.toUpperCase()}${sep}NOT-A-REAL-FILE.txt`

  it.runIf(VOLUME_INSENSITIVE)('大小写不敏感的盘:改大小写绕不过去,仍算在根内', () => {
    expect(() => resolveInWorkspace(root, shouted())).not.toThrow()
    // 而且落回的是**盘上真实的那个写法**,不是调用方喊出来的那个 ——
    // 否则同一个文件会因为大小写不同变成两个 Tab、两条展开状态
    expect(toWorkspaceRelative(root, resolveInWorkspace(root, shouted()))).toBe(
      'NOT-A-REAL-FILE.txt'
    )
  })

  it.runIf(!VOLUME_INSENSITIVE)('大小写敏感的盘:大小写不同就是另一个目录,拦掉', () => {
    expect(() => resolveInWorkspace(root, shouted())).toThrow(PathEscapeError)
  })
})

/**
 * 反向那一半。渲染层拿到的路径一律是这种形式 —— 跨平台稳定,
 * 且 UI 里永远不出现用户的绝对路径。
 */
describe('toWorkspaceRelative', () => {
  it('压回相对形式', () => {
    expect(toWorkspaceRelative(root, resolveInWorkspace(root, 'src/index.ts'))).toBe('src/index.ts')
  })

  it('根本身是空串', () => {
    expect(toWorkspaceRelative(root, resolveInWorkspace(root, ''))).toBe('')
  })

  /** ★ 分隔符**永远是 `/`**,Windows 上也是 —— 它是持久化里的 key */
  it('分隔符一律是正斜杠', () => {
    const rel = toWorkspaceRelative(root, resolveInWorkspace(root, 'a/b/c'))
    expect(rel).toBe('a/b/c')
    expect(rel.includes('\\')).toBe(false)
  })

  it('和 resolveInWorkspace 互为逆运算', () => {
    for (const p of ['src/index.ts', 'a/b/c', 'src/brand-new.ts']) {
      expect(toWorkspaceRelative(root, resolveInWorkspace(root, p)), p).toBe(p)
    }
  })
})

/**
 * ★ 同一套归一化,只是不抛。这一组和上面「拦截」那一组是**同样的输入**,
 * 断言的是同一件事的另一面:那些路径确实被认出在根外,而不是被拒绝。
 */
describe('resolveAnywhere', () => {
  it('根内:outside 为假,路径和 resolveInWorkspace 一致', () => {
    for (const p of ['src/index.ts', 'a/b/c', '.', join(root, 'src', 'index.ts')]) {
      const r = resolveAnywhere(root, p)
      expect(r.outside, p).toBe(false)
      expect(r.abs, p).toBe(resolveInWorkspace(root, p))
    }
  })

  it('根外:outside 为真,且给出目标的真实路径', () => {
    for (const p of ['../outside/secret.txt', 'src/../../outside/secret.txt', join(outside, 'secret.txt')]) {
      const r = resolveAnywhere(root, p)
      expect(r.outside, p).toBe(true)
      expect(r.abs, p).toBe(realpathSync.native(join(outside, 'secret.txt')))
    }
  })

  /** 软链是词法检查看不见的那一种 —— 现在跟着它走,并如实报告落到了根外 */
  it('指向根外的符号链接:跟着走,报告在外面', () => {
    const r = resolveAnywhere(root, 'escape/secret.txt')
    expect(r.outside).toBe(true)
    expect(r.abs).toBe(realpathSync.native(join(outside, 'secret.txt')))
  })

  /** 目标还不存在也要能解析,否则往工作区外写一个新文件永远失败 */
  it('根外还不存在的目标', () => {
    const r = resolveAnywhere(root, join(outside, 'brand-new.txt'))
    expect(r.outside).toBe(true)
    expect(r.abs).toBe(join(realpathSync.native(outside), 'brand-new.txt'))
  })

  /**
   * ★ 没有工作区根时,绝对路径照样成立 —— 它本来就不需要基准。
   * 相对路径没有基准,那时才抛(调用方据此给出「先打开一个工作区」的说法)。
   */
  it('空的根:绝对路径可解析,相对路径抛', () => {
    expect(resolveAnywhere('', join(outside, 'secret.txt'))).toEqual({
      abs: realpathSync.native(join(outside, 'secret.txt')),
      outside: true
    })
    expect(() => resolveAnywhere('', 'src/index.ts')).toThrow()
  })
})

/**
 * ★ 这一组测的是「一条路径**怎么写给模型**」—— 工具回执(`relOf`)和用户拖/选进来的
 * 文件引用(`file_ref`)共用它。工作区内压成相对、工作区外保留绝对,两种形式都得对,
 * 因为模型是照着这个字符串决定下一步喂什么参数的。
 */
describe('displayPath', () => {
  it('工作区内 → 工作区相对', () => {
    expect(displayPath(root, join(root, 'src', 'index.ts'))).toBe('src/index.ts')
  })

  it('工作区外 → 保留绝对路径(与工具回执同形,realpath 过)', () => {
    expect(displayPath(root, join(outside, 'secret.txt'))).toBe(
      realpathSync.native(join(outside, 'secret.txt'))
    )
  })

  /**
   * ★ 这一条是这个函数存在的理由。macOS 上工作区根记录的是 `showOpenDialog`
   * 原样返回的没折算过的路径,而拖进来的文件路径已经是 realpath 过的 ——
   * 拿字符串前缀比的话,工作区**内**的文件会被判到外面去,一条本该是
   * `src/index.ts` 的引用于是写成了一长串绝对路径。
   */
  it('★ 根是软链别名时仍判为工作区内', () => {
    const linked = join(base, 'ws-link')
    expect(displayPath(linked, realpathSync.native(join(root, 'src', 'index.ts')))).toBe('src/index.ts')
  })

  it('根本身 → `.`,不是空串', () => {
    expect(displayPath(root, root)).toBe('.')
  })

  it('★ 绝不产出 ../ —— 那种形式对不上任何一个根', () => {
    // 兄弟目录:词法上正是 `../outside/secret.txt` 那一类
    const out = displayPath(root, join(base, 'outside', 'secret.txt'))
    expect(out.startsWith('..')).toBe(false)
    expect(out).toBe(realpathSync.native(join(outside, 'secret.txt')))
  })

  it('没有工作区 → 绝对路径原样给出', () => {
    const abs = join(outside, 'secret.txt')
    expect(displayPath('', abs)).toBe(abs)
  })

  it('根已被删除 → 不抛,退回绝对路径', () => {
    expect(displayPath(join(base, '早就没了'), join(outside, 'secret.txt'))).toBe(
      realpathSync.native(join(outside, 'secret.txt'))
    )
  })
})
