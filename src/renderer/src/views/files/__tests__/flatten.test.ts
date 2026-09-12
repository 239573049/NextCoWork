import { describe, expect, it } from 'vitest'
import type { DirListing, FileEntry } from '../../../../../shared/domain/file-tree'
import { flatten, type Row } from '../flatten'

/**
 * 文件树摊平。它是右侧面板那一带**唯一有分支的纯逻辑**,而那个分支
 * (走到目录那行时先无条件压进去、子树走完发现两边都没中再 `splice` 撤掉)
 * 恰好也是最难靠眼睛看对的一段 —— 撤销的是一段**已经压进去的区间**,
 * 多撤一行会吃掉前面的兄弟,少撤一行会留下一个空目录壳。
 */

const f = (path: string, extra: Partial<FileEntry> = {}): FileEntry => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, kind: 'file', hidden: name.startsWith('.'), ...extra }
}
const d = (path: string, extra: Partial<FileEntry> = {}): FileEntry => f(path, { kind: 'dir', ...extra })

const listing = (path: string, entries: FileEntry[]): DirListing => ({ path, entries, truncated: false })

/*
  一棵刻意做小、但每种情况各占一条的树:

    docs/          展开且加载好了 —— 正常的那种
    node_modules/  展开了但**没加载回来** —— 懒加载的那种
    src/           两层深 —— 验证 depth 和「插在中间」
    .git/          隐藏目录,底下还有东西 —— 验证跳过的是整个分支不是一行
    package.json   根上的文件,排在所有目录后面
    .env           隐藏文件

  mtime 给成和名字序相反,这样按时间排能测出来确实换了顺序。
*/
const TREE: Readonly<Record<string, DirListing>> = {
  '': listing('', [
    d('docs', { mtime: 10 }),
    d('node_modules', { mtime: 20 }),
    d('src', { mtime: 30 }),
    d('.git', { mtime: 40 }),
    f('package.json', { mtime: 50 }),
    f('.env', { mtime: 60 })
  ]),
  docs: listing('docs', [f('docs/plan.md')]),
  src: listing('src', [d('src/views'), f('src/index.ts')]),
  'src/views': listing('src/views', [f('src/views/Files.tsx')]),
  '.git': listing('.git', [f('.git/config')])
}

const ALL_OPEN = new Set(['docs', 'node_modules', 'src', 'src/views', '.git'])

/**
 * ★ 断言用**缩进后的名字**,不是名字数组 + depth 数组两条。
 * 摊平的结果本来就是一棵树压出来的,写成带缩进的样子,
 * 期望值长得和界面上看到的一模一样 —— 顺序错了、层级错了都是一眼的事。
 */
const shape = (rows: readonly Row[]): string[] =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.entry.name}`)

/** 默认参数的薄壳,免得每条都写六个位置参数 */
const run = (
  o: {
    expanded?: Iterable<string>
    sortBy?: 'name' | 'mtime' | 'size'
    showHidden?: boolean
    query?: string | null
    root?: string
    listings?: Readonly<Record<string, DirListing>>
    selectedPath?: string | null
  } = {}
): string[] =>
  shape(
    flatten(
      o.listings ?? TREE,
      new Set(o.expanded ?? []),
      o.root ?? '',
      o.sortBy ?? 'name',
      o.showHidden ?? false,
      o.query ?? null,
      o.selectedPath ?? null
    )
  )

describe('flatten · 展开与层级', () => {
  it('什么都没展开时只有根这一层', () => {
    expect(run()).toEqual(['docs', 'node_modules', 'src', 'package.json'])
  })

  /** 根自己还没加载回来(首帧)—— 返回空数组,不是抛 */
  it('根没加载回来时是空的', () => {
    expect(run({ listings: {} })).toEqual([])
  })

  /** ★ 子项**插在父目录后面**,不是接在整个列表末尾 */
  it('展开一层:子项插在父目录正下方并缩进一级', () => {
    expect(run({ expanded: ['src'] })).toEqual([
      'docs',
      'node_modules',
      'src',
      '  views',
      '  index.ts',
      'package.json'
    ])
  })

  it('展开两层:深度继续累加', () => {
    expect(run({ expanded: ['src', 'src/views'] })).toEqual([
      'docs',
      'node_modules',
      'src',
      '  views',
      '    Files.tsx',
      '  index.ts',
      'package.json'
    ])
  })

  /**
   * ★ **懒加载的全部意义就在这一条。** `node_modules` 被点开了,
   * 但那一层还没拉回来 —— 此时既不能炸,也不能画出上一次的内容,
   * 就是一行都不出。真正的 `node_modules` 有上万项,
   * 「展开状态」和「已加载」必须是两件独立的事。
   */
  it('展开了但还没加载回来的目录,一行子项都不出', () => {
    expect(run({ expanded: ['node_modules'] })).toEqual([
      'docs',
      'node_modules',
      'src',
      'package.json'
    ])
  })

  /** 展开一个根本不存在的路径不影响任何东西 */
  it('展开表里的野路径被忽略', () => {
    expect(run({ expanded: ['不存在的目录', 'src/views'] })).toEqual(run())
  })
})

describe('flatten · 隐藏文件', () => {
  it('默认不显示隐藏项', () => {
    expect(run({ expanded: ALL_OPEN })).not.toContain('.env')
  })

  /**
   * ★ 「在文件管理器中显示」一个 `.env` 之后,树开出来了却一行都没有 —— 用户看到的是
   * 「点了没反应」,而且没有任何线索告诉他要去开隐藏项开关。被点名选中的那一项
   * 不受隐藏过滤约束,其余隐藏项照旧不出。
   */
  it('被 reveal 选中的隐藏项照常出现,其余隐藏项不受影响', () => {
    const rows = run({ selectedPath: '.env' })
    expect(rows).toContain('.env')
    expect(rows, '只放行被选中的那一项').not.toContain('.git')
  })

  /**
   * 选中的隐藏目录如果正好是展开的,它的普通子项要跟着出来 —— 一个展开着却空无一物的
   * 目录壳比不显示更让人困惑。放行仅限被选中的那一项本身,`.env` 仍然不出。
   */
  it('选中的隐藏目录展开时,它的普通子项跟着出来', () => {
    const rows = run({ expanded: ALL_OPEN, selectedPath: '.git' })
    expect(rows).toContain('.git')
    expect(rows).toContain('  config')
    expect(rows, '没被选中的隐藏项照旧不出').not.toContain('.env')
  })

  /**
   * ★ 跳过的是**整个分支**,不只是那一行。`.git` 被过滤掉时
   * 它底下的 `config` 也不能冒出来 —— 否则会出现一个没有父目录、
   * 却缩进了一级的孤儿行。
   */
  it('隐藏目录连同它底下的东西一起不出', () => {
    const rows = run({ expanded: ALL_OPEN })
    expect(rows).not.toContain('.git')
    expect(rows).not.toContain('  config')
  })

  it('打开开关后隐藏项和它的子树都出来', () => {
    expect(run({ expanded: ALL_OPEN, showHidden: true })).toEqual([
      '.git',
      '  config',
      'docs',
      '  plan.md',
      'node_modules',
      'src',
      '  views',
      '    Files.tsx',
      '  index.ts',
      '.env',
      'package.json'
    ])
  })
})

describe('flatten · 排序', () => {
  /**
   * 排序本身在 `sortEntries` 里测过了,这里只验证**每一层都排** ——
   * 而不是只排根那一层、深层保持磁盘顺序。
   */
  it('sortBy 透传到每一层', () => {
    expect(run({ expanded: ['src'], sortBy: 'mtime' })).toEqual([
      'src',
      // 子层没有 mtime,一律 0,回落到名字;目录仍在文件前
      '  views',
      '  index.ts',
      'node_modules',
      'docs',
      'package.json'
    ])
  })

  /** 目录在前是 `sortEntries` 定的,这里确认摊平没把它打乱:`views` > `index.ts`(名字序)却排在前面 */
  it('每一层都是目录在前', () => {
    expect(run({ expanded: ['src'] }).slice(3, 5)).toEqual(['  views', '  index.ts'])
  })
})

describe('flatten · 搜索', () => {
  /**
   * ★ **命中项的祖先目录必须留着。** 只留命中的那一行的话,
   * 结果是一列没有上下文的文件名 —— 看不出 `Files.tsx` 到底在哪个目录下,
   * 而缩进还在,视觉上更像坏了。
   */
  it('命中文件时保留它的整条祖先链', () => {
    expect(run({ expanded: ALL_OPEN, query: 'Files' })).toEqual(['src', '  views', '    Files.tsx'])
  })

  /**
   * ★ 本文件的核心一条,同时压住 `splice` 的两个方向:
   *
   * - `node_modules` 和 `src` 都是**先压进去再撤掉**的 —— `src` 撤的时候,
   *   它底下的 `views` 已经在数组里了,必须**连着一起**撤,不能只撤自己那一行;
   * - 而 `docs` / `plan.md` 排在它们**前面**,一行都不许被误伤。
   *   撤销撤的是 `out.splice(at)` 那个区间,`at` 记早了就会吃掉前面的兄弟。
   */
  it('整棵子树都没命中的目录被连根撤掉,且不误伤前面的兄弟', () => {
    expect(run({ expanded: ALL_OPEN, query: 'plan' })).toEqual(['docs', '  plan.md'])
  })

  /**
   * ★ 目录**自己**命中时留自己,但**子项仍各自过滤** ——
   * 不是「命中一个目录就把整棵子树放出来」。
   */
  it('目录名自己命中时只留它自己,子项照旧过滤', () => {
    expect(run({ expanded: ALL_OPEN, query: 'views' })).toEqual(['src', '  views'])
  })

  /**
   * ★ 搜索只在**已加载**的部分里过滤 —— 这是个真实的行为边界,不是缺陷:
   * 真要全局搜就得走主进程,而不是把整棵树先拉下来。
   * `src/views` 没展开,里面的 `Files.tsx` 就搜不到,`src` 也跟着被撤掉。
   */
  it('没展开的目录里的命中搜不到', () => {
    expect(run({ expanded: ['src'], query: 'Files' })).toEqual([])
  })

  it('大小写不敏感,且首尾空格不算数', () => {
    expect(run({ expanded: ALL_OPEN, query: '  FILES  ' })).toEqual([
      'src',
      '  views',
      '    Files.tsx'
    ])
  })

  /** 搜索框开着但还没输入 —— 等同于没在搜,不是「什么都不匹配」 */
  it('空串等同于不过滤', () => {
    expect(run({ expanded: ALL_OPEN, query: '' })).toEqual(run({ expanded: ALL_OPEN }))
    expect(run({ expanded: ALL_OPEN, query: '   ' })).toEqual(run({ expanded: ALL_OPEN }))
  })

  it('一条都没命中时是空数组', () => {
    expect(run({ expanded: ALL_OPEN, query: '这个字符串不存在' })).toEqual([])
  })

  /** 搜索不改变层级:留下来的行缩进和不搜时一样 */
  it('命中行的缩进和不搜索时一致', () => {
    const withQuery = flatten(TREE, ALL_OPEN, '', 'name', false, 'Files.tsx')
    const without = flatten(TREE, ALL_OPEN, '', 'name', false, null)
    const depthOf = (rows: readonly Row[], name: string): number | undefined =>
      rows.find((r) => r.entry.name === name)?.depth
    expect(depthOf(withQuery, 'Files.tsx')).toBe(depthOf(without, 'Files.tsx'))
  })
})

describe('flatten · 子树根', () => {
  /** 右侧面板可以以某个子目录为根开一个 Tab(InnerTab 的 `files.ref.path`) */
  it('从子目录起算,深度从 0 重新开始', () => {
    expect(run({ root: 'src', expanded: ['src/views'] })).toEqual([
      'views',
      '  Files.tsx',
      'index.ts'
    ])
  })
})
