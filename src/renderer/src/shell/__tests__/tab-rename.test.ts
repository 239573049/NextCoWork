/**
 * 双击改名的分派与扩展名保护。
 *
 * 这两件事错了都**不会报错**:选错去向的表现是「改完过一会儿自己变回去」,
 * 丢掉扩展名的表现是「文件还在,但谁也打不开它了」。
 */
import { describe, expect, it } from 'vitest'
import type { InnerTab } from '../../../../shared/domain/tab'
import { baseName, fileNameStem, restoreExtension, tabRenameTarget } from '../tab-rename'

const tab = (over: Partial<InnerTab> & Pick<InnerTab, 'kind' | 'ref'>): InnerTab =>
  ({ id: 't', pane: 'main', title: 'x', ...over }) as InnerTab

describe('tabRenameTarget', () => {
  it('对话标签改的是会话标题', () => {
    expect(tabRenameTarget(tab({ kind: 'chat', ref: { sessionId: 's1' } }))).toEqual({ kind: 'session' })
    // 草稿态也给入口 —— 提交时再铸 id
    expect(tabRenameTarget(tab({ kind: 'chat', ref: { sessionId: null } }))).toEqual({ kind: 'session' })
  })

  it('★ 文件类标签改的是磁盘上的文件,四种 kind 一视同仁', () => {
    for (const kind of ['doc', 'draw', 'preview'] as const) {
      expect(tabRenameTarget(tab({ kind, ref: { path: 'a/b.md' } })), kind).toEqual({ kind: 'file', path: 'a/b.md' })
    }
    expect(tabRenameTarget(tab({
      kind: 'custom',
      ref: { pluginId: 'acme.excalidraw', viewType: 'excalidraw.editor', path: 'plan.excalidraw' }
    }))).toEqual({ kind: 'file', path: 'plan.excalidraw' })
  })

  it('★ 还没落盘的草稿不给改名入口 —— 改一个"本地别名"只会骗人', () => {
    expect(tabRenameTarget(tab({ kind: 'doc', ref: { path: '' } }))).toBeNull()
    expect(tabRenameTarget(tab({ kind: 'custom', ref: { pluginId: 'p', viewType: 'v', path: '' } }))).toBeNull()
  })

  it('终端 / 浏览器 / 文件树改的是本地别名', () => {
    expect(tabRenameTarget(tab({ kind: 'terminal', ref: { terminalId: 'x' } }))).toEqual({ kind: 'local' })
    expect(tabRenameTarget(tab({ kind: 'browser', ref: { url: 'https://x' } }))).toEqual({ kind: 'local' })
    expect(tabRenameTarget(tab({ kind: 'files', ref: { path: 'src' } }))).toEqual({ kind: 'local' })
  })
})

describe('fileNameStem', () => {
  it('默认选区是扩展名之前那一段', () => {
    expect(fileNameStem('plan.excalidraw')).toBe('plan')
    expect(fileNameStem('a.b.md')).toBe('a.b')
  })

  it('没有扩展名时全选', () => {
    expect(fileNameStem('Makefile')).toBe('Makefile')
  })

  it('★ 点文件整个都是名字 —— 否则双击 .gitignore 得到一个空选区', () => {
    expect(fileNameStem('.gitignore')).toBe('.gitignore')
    expect(fileNameStem('.env.local')).toBe('.env')
  })
})

describe('restoreExtension', () => {
  it('★ 用户没打扩展名时补回原来那个', () => {
    expect(restoreExtension('b', 'a.excalidraw')).toBe('b.excalidraw')
    expect(restoreExtension('  b  ', 'a.excalidraw')).toBe('b.excalidraw')
  })

  it('用户自己打了扩展名就照搬 —— 那是他要换类型', () => {
    expect(restoreExtension('b.md', 'a.excalidraw')).toBe('b.md')
  })

  it('原名本来就没有扩展名时不凭空造一个', () => {
    expect(restoreExtension('LICENSE', 'Makefile')).toBe('LICENSE')
  })

  it('★ 点文件名照搬,不当成"缺了扩展名"', () => {
    expect(restoreExtension('.gitignore', 'a.excalidraw')).toBe('.gitignore')
  })

  it('空串原样返回,交给既有的校验去拒', () => {
    expect(restoreExtension('   ', 'a.excalidraw')).toBe('')
  })
})

describe('baseName', () => {
  it('取最后一段', () => {
    expect(baseName('a/b/c.md')).toBe('c.md')
    expect(baseName('c.md')).toBe('c.md')
  })
})
