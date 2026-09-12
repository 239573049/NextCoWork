/**
 * 「选择导入」的判断逻辑。★ 这几条规则如果留在 `.tsx` 里,vitest 一行都测不到
 * (node 环境 + 只收 `.test.ts`)—— 这个文件存在的理由就是它们值得被守住。
 */
import { describe, expect, it } from 'vitest'
import type { ImportPreviewItem, ImportProjectCandidate } from '../../../../../../shared/domain/import'
import {
  groupState,
  initialSelection,
  isSelectable,
  resolvedProjectKeys,
  selectedCounts,
  submitBlockers,
  toggleGroup,
  toggleItem
} from '../selection'

function item(over: Partial<ImportPreviewItem> & { id: string }): ImportPreviewItem {
  return {
    category: 'chat',
    title: over.id,
    sourcePath: `/src/${over.id}`,
    status: 'new',
    scope: 'project',
    diagnostics: [],
    defaultSelected: true,
    ...over
  }
}

describe('分组勾选态', () => {
  it('★ 分母只算可选项 —— 全选之后不该还是半选', () => {
    const items = [
      item({ id: 'a', status: 'new' }),
      item({ id: 'b', status: 'incompatible' }),
      item({ id: 'c', status: 'exists' })
    ]
    expect(groupState(items, new Set(['a']))).toBe('all')
  })

  it('一个都没勾是 none,勾了一部分是 some', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })]
    expect(groupState(items, new Set())).toBe('none')
    expect(groupState(items, new Set(['a']))).toBe('some')
    expect(groupState(items, new Set(['a', 'b']))).toBe('all')
  })

  it('全是不可选项时是 none,而不是 all', () => {
    const items = [item({ id: 'a', status: 'incompatible' })]
    expect(groupState(items, new Set())).toBe('none')
  })

  it('半选态点一下变全选,全选态点一下清空', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })]
    expect([...toggleGroup(items, new Set(['a']))].sort()).toEqual(['a', 'b'])
    expect([...toggleGroup(items, new Set(['a', 'b']))]).toEqual([])
  })
})

describe('单项勾选', () => {
  it('不可选的项点不动', () => {
    const blocked = item({ id: 'x', status: 'incompatible' })
    expect(isSelectable(blocked)).toBe(false)
    expect([...toggleItem(blocked, new Set())]).toEqual([])
  })

  it('普通 needs-target 会被禁用 —— 没有目标时不能导入聊天', () => {
    expect(isSelectable(item({ id: 'x', status: 'needs-target', projectKey: '/p' }))).toBe(false)
  })

  it('缺失的项目本身可选，提交时由主进程自动创建 workspace', () => {
    const project = item({ id: 'p', category: 'project', status: 'needs-target', projectKey: '/missing', defaultSelected: false })
    expect(isSelectable(project)).toBe(true)
    expect(resolvedProjectKeys([project], new Set(['p']), [], new Map()).has('/missing')).toBe(true)
  })

  it('★★ 但项目这一轮会落地时,它下面的聊天必须变得可选', () => {
    // 这条是隔离 Electron 探针抓出来的:全新安装上每个项目都还没有工作区,
    // 于是聊天恒为 needs-target。无条件禁止的话,用户**没有任何办法**把聊天导进来 ——
    // 症状是导入「成功」、计数非零,而会话列表空空如也。
    const chat = item({ id: 'c', category: 'chat', status: 'needs-target', projectKey: '/p' })
    const project = item({ id: 'p', category: 'project', status: 'new', projectKey: '/p' })
    const resolved = resolvedProjectKeys([chat, project], new Set(['p']), [], new Map())
    expect(resolved.has('/p')).toBe(true)
    expect(isSelectable(chat, resolved)).toBe(true)
  })

  it('用户在弹窗里现指一个工作区,同样让聊天可选', () => {
    const chat = item({ id: 'c', category: 'chat', status: 'needs-target', projectKey: '/p' })
    const resolved = resolvedProjectKeys([chat], new Set(), [], new Map([['/p', 'ws9']]))
    expect(isSelectable(chat, resolved)).toBe(true)
  })

  it('默认勾选照抄主进程的 defaultSelected,不在渲染层重算判据', () => {
    const items = [
      item({ id: 'a', defaultSelected: true }),
      item({ id: 'b', defaultSelected: false }),
      // 主进程说要勾,但它不可选 —— 以可选性为准,否则提交会带上一个必然失败的 id
      item({ id: 'c', defaultSelected: true, status: 'exists' })
    ]
    expect([...initialSelection(items)]).toEqual(['a'])
  })

  it('★ 全新安装:默认就把项目和它下面的聊天一起勾上', () => {
    const items = [
      item({ id: 'p', category: 'project', status: 'new', projectKey: '/p', defaultSelected: true }),
      item({ id: 'c', category: 'chat', status: 'needs-target', projectKey: '/p', defaultSelected: false })
    ]
    expect([...initialSelection(items)].sort()).toEqual(['c', 'p'])
  })
})

describe('提交门禁', () => {
  const projects: ImportProjectCandidate[] = [
    { key: '/p/mapped', sourcePath: '/p/mapped', accessible: true, targetWorkspaceId: 'ws1', sessionCount: 1, diagnostics: [] },
    { key: '/p/unmapped', sourcePath: '/p/unmapped', accessible: true, sessionCount: 1, diagnostics: [] }
  ]

  it('什么都没选就不能提交', () => {
    expect(submitBlockers([item({ id: 'a' })], new Set(), projects, new Map()).ok).toBe(false)
  })

  it('★ 选中的聊天缺目标工作区时挡住提交,而不是让它们全部变成 skipped', () => {
    const items = [item({ id: 'a', category: 'chat', projectKey: '/p/unmapped' })]
    const result = submitBlockers(items, new Set(['a']), projects, new Map())
    expect(result.ok).toBe(false)
    expect(result.missingProjects).toEqual(['/p/unmapped'])
  })

  it('同一轮里把那个项目也勾上,提交就不再被挡 —— 项目排在聊天之前落地', () => {
    const items = [
      item({ id: 'a', category: 'chat', projectKey: '/p/unmapped' }),
      item({ id: 'p', category: 'project', status: 'new', projectKey: '/p/unmapped' })
    ]
    expect(submitBlockers(items, new Set(['a', 'p']), projects, new Map()).ok).toBe(true)
  })

  it('项目已经有映射,或用户在弹窗里现指了一个,都算数', () => {
    const mapped = [item({ id: 'a', category: 'chat', projectKey: '/p/mapped' })]
    expect(submitBlockers(mapped, new Set(['a']), projects, new Map()).ok).toBe(true)

    const picked = [item({ id: 'b', category: 'chat', projectKey: '/p/unmapped' })]
    expect(submitBlockers(picked, new Set(['b']), projects, new Map([['/p/unmapped', 'ws9']])).ok).toBe(true)
  })

  it('非聊天项不受工作区门禁影响 —— 全局技能不属于任何项目', () => {
    const items = [item({ id: 's', category: 'skill', scope: 'global' })]
    expect(submitBlockers(items, new Set(['s']), projects, new Map()).ok).toBe(true)
  })

  it('计数按类别分开,给提交按钮上那个数字', () => {
    const items = [
      item({ id: 'a', category: 'chat' }),
      item({ id: 'b', category: 'chat' }),
      item({ id: 'c', category: 'skill' })
    ]
    const counts = selectedCounts(items, new Set(['a', 'c']))
    expect(counts.total).toBe(2)
    expect(counts.byCategory).toEqual({ chat: 1, skill: 1 })
  })
})
