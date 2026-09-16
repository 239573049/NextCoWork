/**
 * 补删清单：上一次「删除并退出」搬不动的路径，靠它在下次启动时收尾。
 *
 * 这份清单是磁盘上的普通 JSON，谁都能改。所以这里的重点不在「能不能删掉」，
 * 而在**删之前那道边界校验**：一个被改过的清单绝不能让启动路径去删数据根之外
 * 的东西，也不能把数据根自己整棵端掉。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PENDING_DELETE_FILENAME, recordPendingDelete, sweepPendingDelete } from '../pending-delete'

let root = ''
let outside = ''

function recordFile(): string {
  return join(root, PENDING_DELETE_FILENAME)
}

function readPaths(): string[] {
  return (JSON.parse(readFileSync(recordFile(), 'utf8')) as { paths: string[] }).paths
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-pending-root-'))
  outside = mkdtempSync(join(tmpdir(), 'nextcowork-pending-outside-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('补删清单的记账', () => {
  it('连续两次记账取并集，不覆盖上一轮的账', () => {
    mkdirSync(join(root, 'GPUCache'))
    mkdirSync(join(root, 'Cache'))
    recordPendingDelete(root, [join(root, 'GPUCache')])
    recordPendingDelete(root, [join(root, 'Cache')])

    expect(readPaths()).toEqual([join(root, 'GPUCache'), join(root, 'Cache')])
  })

  it('空列表不创建清单文件', () => {
    recordPendingDelete(root, [])
    expect(existsSync(recordFile())).toBe(false)
  })
})

describe('启动时补删', () => {
  it('删掉清单里的目录并清除清单本身', () => {
    const cache = join(root, 'GPUCache')
    mkdirSync(cache)
    writeFileSync(join(cache, 'shader.bin'), 'cached')
    recordPendingDelete(root, [cache])

    expect(sweepPendingDelete(root)).toEqual({ removed: 1, remaining: 0 })
    expect(existsSync(cache)).toBe(false)
    expect(existsSync(recordFile())).toBe(false)
  })

  it('拒绝数据根之外的路径，目标完好无损', () => {
    const victim = join(outside, 'important')
    mkdirSync(victim)
    writeFileSync(join(victim, 'keep.txt'), 'keep')
    writeFileSync(recordFile(), JSON.stringify({ recordedAt: Date.now(), paths: [victim] }), 'utf8')

    expect(sweepPendingDelete(root)).toEqual({ removed: 0, remaining: 0 })
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('拒绝数据根本身', () => {
    writeFileSync(join(root, 'keep.txt'), 'keep')
    writeFileSync(recordFile(), JSON.stringify({ recordedAt: Date.now(), paths: [root] }), 'utf8')

    expect(sweepPendingDelete(root)).toEqual({ removed: 0, remaining: 0 })
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('已经不存在的路径算删掉了，不会一轮轮攒着', () => {
    recordPendingDelete(root, [join(root, 'GPUCache')])

    expect(sweepPendingDelete(root)).toEqual({ removed: 1, remaining: 0 })
    expect(existsSync(recordFile())).toBe(false)
  })

  it('没有清单时静默返回', () => {
    expect(sweepPendingDelete(root)).toEqual({ removed: 0, remaining: 0 })
  })

  it('清单损坏时不抛错，并把坏文件清掉', () => {
    writeFileSync(recordFile(), '{ 半截写坏的 JSON', 'utf8')

    expect(sweepPendingDelete(root)).toEqual({ removed: 0, remaining: 0 })
    expect(existsSync(recordFile())).toBe(false)
  })
})
