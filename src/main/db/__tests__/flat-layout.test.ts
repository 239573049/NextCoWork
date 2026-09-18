/**
 * 扁平布局 → `data/` 的一次性收拢。
 *
 * 这段代码搬的是用户**全部**的真实数据(那台开发机上是 399M),而且跑在启动路径上、
 * 出错时没有第二次机会。三条边界值得钉死:
 *
 * 1. 搬完之后旧位置**不复存在** —— 用的是 rename 不是 copy。
 * 2. 中途失败必须**逆序回滚回原位**,不能留下半截布局(见 flat-layout-rollback.test.ts)。
 * 3. 库里存着的绝对路径要跟着改,漏一处的表现都是「我的东西没了」。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DATA_SUBDIRNAME, DB_FILENAME, closeDatabase, openDatabase } from '../index'
import type { Workspace } from '../../../shared/domain/workspace'
import * as repo from '../repo'
import { migrateFlatLayout, rewriteMigratedPaths } from '../flat-layout'

let root = ''
let dataRoot = ''

beforeEach(() => {
  closeDatabase()
  root = mkdtempSync(join(tmpdir(), 'nextcowork-flat-'))
  dataRoot = join(root, DATA_SUBDIRNAME)
})

afterEach(() => {
  vi.restoreAllMocks()
  closeDatabase()
  rmSync(root, { recursive: true, force: true })
})

/** 在 profile 根上直接铺一套旧的扁平布局。 */
function seedFlatLayout(): void {
  // 真库,不是空文件 —— 迁移之后还要能打开它改路径。
  openDatabase(root)
  closeDatabase()
  mkdirSync(join(root, 'attachments', 'sessions', 's1'), { recursive: true })
  writeFileSync(join(root, 'attachments', 'sessions', 's1', 'a.png'), 'png')
  mkdirSync(join(root, 'skills', 'my-skill'), { recursive: true })
  writeFileSync(join(root, 'skills', 'my-skill', 'SKILL.md'), '自己写的技能')
  mkdirSync(join(root, 'workspaces', 'default'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), '全局指令')
  writeFileSync(join(root, 'settings.json'), '{"version":1}')
  // Chromium 的东西,本来就该留在根层。
  mkdirSync(join(root, 'GPUCache'))
  writeFileSync(join(root, 'GPUCache', 'shader.bin'), 'cached')
  mkdirSync(join(root, 'Partitions'))
  writeFileSync(join(root, 'Cookies'), 'chromium')
}

describe('扁平布局搬进 data/', () => {
  it('应用数据搬进 data/,Chromium 的条目原地不动', () => {
    seedFlatLayout()

    expect(migrateFlatLayout(root, dataRoot)).toBe(true)

    // 搬到位了
    expect(existsSync(join(dataRoot, DB_FILENAME))).toBe(true)
    expect(readFileSync(join(dataRoot, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe('自己写的技能')
    expect(readFileSync(join(dataRoot, 'AGENTS.md'), 'utf8')).toBe('全局指令')
    expect(existsSync(join(dataRoot, 'attachments', 'sessions', 's1', 'a.png'))).toBe(true)
    expect(existsSync(join(dataRoot, 'workspaces', 'default'))).toBe(true)
    expect(existsSync(join(dataRoot, 'settings.json'))).toBe(true)

    // ★ 是 rename 不是 copy —— 旧位置必须空了,否则用户看到两份、下次启动挑错
    expect(existsSync(join(root, DB_FILENAME))).toBe(false)
    expect(existsSync(join(root, 'skills'))).toBe(false)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)

    // Chromium 的归 Chromium
    expect(readFileSync(join(root, 'GPUCache', 'shader.bin'), 'utf8')).toBe('cached')
    expect(existsSync(join(root, 'Partitions'))).toBe(true)
    expect(existsSync(join(root, 'Cookies'))).toBe(true)
    expect(existsSync(join(dataRoot, 'GPUCache'))).toBe(false)
  })

  it('根层没有库时一个字节都不搬,也不造出空的 data/', () => {
    mkdirSync(join(root, 'GPUCache'))

    expect(migrateFlatLayout(root, dataRoot)).toBe(false)
    expect(existsSync(dataRoot)).toBe(false)
  })

  it('目标已存在的条目跳过而不是覆盖 —— 上一轮可能搬到一半崩了', () => {
    seedFlatLayout()
    mkdirSync(join(dataRoot, 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(dataRoot, 'skills', 'my-skill', 'SKILL.md'), '新根上已有的')

    expect(migrateFlatLayout(root, dataRoot)).toBe(true)

    expect(readFileSync(join(dataRoot, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe('新根上已有的')
    // 跳过的那一份留在原地,不会被悄悄删掉
    expect(existsSync(join(root, 'skills'))).toBe(true)
  })
})

describe('库里存着的绝对路径跟着改', () => {
  /** 迁移只看 `rootPath`,其余字段填成能通过 `normalizeWorkspace` 的最小值。 */
  function workspace(rootPath: string): Workspace {
    return {
      id: 'w1',
      name: '默认',
      rootPath,
      createdAt: 1,
      lastOpenedAt: 1,
      settings: {
        permissionMode: 'ask',
        defaultModel: '',
        defaultMode: 'build',
        defaultThinking: 'off',
        webSearch: false,
        activeSkillIds: []
      }
    }
  }

  /** 在根层的旧布局里种一份指向旧路径的数据,搬完再改写。 */
  function seedAndMigrate(): void {
    openDatabase(root)
    repo.putWorkspace(workspace(join(root, 'workspaces', 'default')))
    repo.ensureSession({
      id: 's1',
      workspaceId: 'w1',
      title: '会话',
      // ★ 一定要显式传。不传就是空串,那条断言会「通过」而什么都没验到。
      rootPathAtCreation: join(root, 'workspaces', 'default')
    })
    closeDatabase()

    expect(migrateFlatLayout(root, dataRoot)).toBe(true)
    rewriteMigratedPaths(join(dataRoot, DB_FILENAME), root, dataRoot)
  }

  /** 绕开 repo,直接看行里存了什么 —— 断言的是磁盘上的事实。 */
  function rawWorkspaceJson(): string {
    const db = new DatabaseSync(join(dataRoot, DB_FILENAME))
    const row = db.prepare('SELECT json FROM workspaces WHERE id = ?').get('w1')
    db.close()
    return String(row?.json ?? '')
  }

  it('★ 工作区根路径指向新根 —— 漏了这条,界面上就是「我的文件都没了」', () => {
    seedAndMigrate()

    const parsed = JSON.parse(rawWorkspaceJson()) as { rootPath: string }
    expect(parsed.rootPath).toBe(join(dataRoot, 'workspaces', 'default'))
    expect(parsed.rootPath.startsWith(dataRoot)).toBe(true)
  })

  it('会话冻结的那份根路径也跟着改', () => {
    seedAndMigrate()

    const db = new DatabaseSync(join(dataRoot, DB_FILENAME))
    const row = db.prepare('SELECT root_path_at_creation FROM sessions WHERE id = ?').get('s1')
    db.close()
    expect(String(row?.root_path_at_creation ?? '')).toBe(join(dataRoot, 'workspaces', 'default'))
  })

  it('不碰旧根之外的路径 —— 用户挂在别处的工作区原样留着', () => {
    const external = mkdtempSync(join(tmpdir(), 'nextcowork-external-'))
    try {
      openDatabase(root)
      repo.putWorkspace(workspace(external))
      closeDatabase()

      migrateFlatLayout(root, dataRoot)
      rewriteMigratedPaths(join(dataRoot, DB_FILENAME), root, dataRoot)

      expect((JSON.parse(rawWorkspaceJson()) as { rootPath: string }).rootPath).toBe(external)
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('库打不开时只 warn,不掀掉启动', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => rewriteMigratedPaths(join(dataRoot, '不存在.db'), root, dataRoot)).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})
