/**
 * `plugin-skills.ts` —— 插件详情页那一屏的取数逻辑。
 *
 * 这几条断言钉的是同一件事:**「插件说它提供了什么」和「模型现在看得见什么」
 * 是两个不同的问题**,而这一屏必须回答后者。照清单画的话,页面会信誓旦旦地
 * 列出一条模型根本看不见的 skill,而作者和用户都没有任何线索。
 */
import { describe, expect, it } from 'vitest'
import type { SkillListItem } from '../../../../../../shared/domain/skill'
import { missingPluginSkills, pluginSkillRows } from '../plugin-skills'

/** 一条扫描器产出的 Skill 投影。默认是「插件带来的、当前生效」。 */
function item(over: Partial<SkillListItem> & { name: string }): SkillListItem {
  return {
    id: over.name,
    description: `${over.name} 的说明`,
    category: '未分类',
    sourceKind: 'plugin',
    scope: 'plugin',
    globalEnabled: true,
    activeInWorkspace: true,
    sourcePath: `/plugins/acme.pdf/skills/${over.name}`,
    pluginId: 'acme.pdf',
    ...over
  }
}

describe('挑出这个插件贡献的那几条', () => {
  it('只要本插件的,别人的与用户自己的都不算', () => {
    const rows = pluginSkillRows(
      [
        item({ name: 'mine' }),
        item({ name: 'theirs', pluginId: 'acme.other' }),
        // 用户自己装的:没有 pluginId
        { ...item({ name: 'user-owned' }), pluginId: undefined, scope: 'global', sourceKind: 'folder' }
      ],
      'acme.pdf'
    )
    expect(rows.map((r) => r.name)).toEqual(['mine'])
  })

  it('按名字排序 —— 列表本身的顺序会随别人的安装而变', () => {
    const rows = pluginSkillRows([item({ name: 'zeta' }), item({ name: 'alpha' })], 'acme.pdf')
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'zeta'])
  })

  it('★ 两个开关任意一个关掉都算「没生效」', () => {
    /*
      用户在这一页看到插件是启用的,而它的 skill 可能被 Skill 页上的开关单独
      关掉了 —— 不区分的话,他只会发现模型从来不用它,而原因在另一个页面上。
    */
    const rows = pluginSkillRows(
      [
        item({ name: 'a', globalEnabled: false }),
        item({ name: 'b', activeInWorkspace: false }),
        item({ name: 'c' })
      ],
      'acme.pdf'
    )
    expect(rows.map((r) => [r.name, r.active])).toEqual([['a', false], ['b', false], ['c', true]])
  })
})

describe('声明了却没出现的那几个', () => {
  it('★★ 加载失败的那条要被认出来 —— 在此之前它在任何界面上都不留痕迹', () => {
    const rows = pluginSkillRows([item({ name: 'works' })], 'acme.pdf')
    const missing = missingPluginSkills(['skills/works', 'skills/broken'], rows)
    expect(missing).toEqual(['broken'])
  })

  it('全都加载成功时是空的', () => {
    const rows = pluginSkillRows([item({ name: 'a' }), item({ name: 'b' })], 'acme.pdf')
    expect(missingPluginSkills(['skills/a', 'skills/b'], rows)).toEqual([])
  })

  it('★★ frontmatter 改了名字**不算**缺失 —— 比的是目录,不是名字', () => {
    /*
      扫描器允许 frontmatter 里的 `name` 和目录名不一样(只记一条诊断)。
      拿名字比的话,那种插件的每一条 skill 都会被误报成「加载失败」——
      一个把注意力引向完全错误方向的假警报。
    */
    const rows = pluginSkillRows(
      [item({ name: 'renamed', sourcePath: '/plugins/acme.pdf/skills/pdf-tools' })],
      'acme.pdf'
    )
    expect(missingPluginSkills(['skills/pdf-tools'], rows)).toEqual([])
  })

  it('★ 被用户同名 Skill 覆盖的那条算缺失', () => {
    /*
      插件优先级最低,用户自己写的同名 skill 会把它顶掉。那条插件 skill 于是
      不在列表里(列表里那条的 pluginId 是空的),这一屏要说出来 ——
      否则用户会以为插件的那条正在生效。
    */
    const rows = pluginSkillRows([], 'acme.pdf')
    expect(missingPluginSkills(['skills/commit-style'], rows)).toEqual(['commit-style'])
  })

  it('Windows 的反斜杠路径也要认', () => {
    const rows = pluginSkillRows(
      [item({ name: 'a', sourcePath: 'C:\\Users\\x\\plugins\\acme.pdf\\skills\\a' })],
      'acme.pdf'
    )
    expect(missingPluginSkills(['skills/a'], rows)).toEqual([])
  })
})
