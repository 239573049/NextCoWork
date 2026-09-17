import { describe, expect, it } from 'vitest'
import {
  assignIds,
  hookListFrom,
  mergeHookLists,
  removeHook,
  setHookEnabled,
  toFileEntry,
  upsertHook
} from '../hook/load'
import { normalizeLocalSettings } from '../../../shared/domain/local-settings'
import type { CommandHook, HookDefinition, HookSettings } from '../../../shared/domain/hook'

const hook = (over: Partial<CommandHook> = {}): HookDefinition => ({
  id: 'h1',
  type: 'command',
  event: 'PreToolUse',
  command: 'echo hi',
  enabled: true,
  timeoutMs: 10_000,
  ...over
})

/** 列表里那一条的「正文」—— 两支各有一个，断言时统一取它。 */
const bodyOf = (h: HookDefinition): string => (h.type === 'prompt' ? h.prompt : h.command)

describe('归一化 · 从文件读进来', () => {
  const norm = (raw: unknown): HookSettings => normalizeLocalSettings({ hooks: raw }).hooks

  it('缺 enabled 默认开着 —— 手写的时候不必每条都带', () => {
    const out = norm({ PreToolUse: [{ id: 'a', command: 'x' }] })
    expect(hookListFrom(out, 'global', '/p')[0]?.enabled).toBe(true)
  })

  it('timeout 是秒，读进来转成毫秒', () => {
    const out = norm({ PreToolUse: [{ id: 'a', command: 'x', timeout: 30 }] })
    expect(hookListFrom(out, 'global', '/p')[0]?.timeoutMs).toBe(30_000)
  })

  it('超过上限的 timeout 被夹住', () => {
    const out = norm({ PreToolUse: [{ id: 'a', command: 'x', timeout: 99_999 }] })
    expect(hookListFrom(out, 'global', '/p')[0]?.timeoutMs).toBe(600_000)
  })

  it('PreToolUse 的默认超时比别的短 —— 它挡在每一次工具调用的关键路径上', () => {
    const pre = hookListFrom(norm({ PreToolUse: [{ id: 'a', command: 'x' }] }), 'global', '/p')[0]
    const stop = hookListFrom(norm({ Stop: [{ id: 'b', command: 'x' }] }), 'global', '/p')[0]
    expect(pre?.timeoutMs).toBe(10_000)
    expect(stop?.timeoutMs).toBe(60_000)
  })

  it('★ 一条读不懂的丢掉，其余照常 —— 不是让整个文件作废', () => {
    const out = norm({
      PreToolUse: [
        { id: 'a', command: 'ok' },
        { id: 'b', command: '' }, // 空命令
        { id: 'c', command: 'x', matcher: 'Bash((((' }, // 非法 matcher
        { id: 'd', command: 'also-ok' }
      ]
    })
    expect(hookListFrom(out, 'global', '/p').map(bodyOf)).toEqual(['ok', 'also-ok'])
  })

  it('认不出的事件名整组丢掉', () => {
    expect(norm({ NotAnEvent: [{ id: 'a', command: 'x' }] })).toEqual({})
  })

  it('★ 读得懂 Claude Code 的嵌套写法并拍平 —— 让「整段粘过来」直接可用', () => {
    const out = norm({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh' }, { type: 'command', command: 'b.sh' }] }]
    })
    const list = hookListFrom(out, 'global', '/p')
    expect(list.map(bodyOf)).toEqual(['a.sh', 'b.sh'])
    expect(list.every((h) => h.matcher === 'Bash')).toBe(true)
  })

  it('超过每事件上限的部分截断', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `h${String(i)}`, command: 'x' }))
    expect(hookListFrom(norm({ PreToolUse: many }), 'global', '/p')).toHaveLength(50)
  })

  it('hooks 段整个是垃圾时返回空对象，不抛', () => {
    expect(norm('nonsense')).toEqual({})
    expect(norm(null)).toEqual({})
    expect(norm([1, 2])).toEqual({})
  })
})

describe('列表与合并', () => {
  it('按 HOOK_EVENTS 的顺序排，不是文件里键的书写顺序', () => {
    const hooks = normalizeLocalSettings({
      hooks: { Stop: [{ id: 's', command: 'x' }], UserPromptSubmit: [{ id: 'u', command: 'y' }] }
    }).hooks
    expect(hookListFrom(hooks, 'global', '/p').map((h) => h.id)).toEqual(['u', 's'])
  })

  it('★ 两层不去重 —— 全局和项目表达的是两个人的意图，各响一次', () => {
    const same = normalizeLocalSettings({ hooks: { Stop: [{ id: 'x', command: 'notify' }] } }).hooks
    const merged = mergeHookLists(hookListFrom(same, 'global', '/g'), hookListFrom(same, 'project', '/p'))
    expect(merged).toHaveLength(2)
    expect(merged.map((h) => h.scope)).toEqual(['global', 'project'])
  })
})

describe('增删改', () => {
  it('upsert 按 id 覆盖', () => {
    const before = upsertHook({}, hook({ command: 'v1' }))
    const after = upsertHook(before, hook({ command: 'v2' }))
    expect(after.PreToolUse).toHaveLength(1)
    expect(after.PreToolUse?.[0]?.command).toBe('v2')
  })

  it('★ 改事件时从旧事件下摘掉 —— 否则它会同时留在两个事件下', () => {
    const before = upsertHook({}, hook({ event: 'PreToolUse' }))
    const after = upsertHook(before, hook({ event: 'PostToolUse' }))
    expect(after.PreToolUse).toBeUndefined()
    expect(after.PostToolUse).toHaveLength(1)
  })

  it('删除只删目标那条', () => {
    let hooks = upsertHook({}, hook({ id: 'a' }))
    hooks = upsertHook(hooks, hook({ id: 'b' }))
    expect(removeHook(hooks, 'a').PreToolUse?.map((e) => e.id)).toEqual(['b'])
  })

  it('开启时把 enabled 键去掉（缺省即 true），关闭时写 false', () => {
    const hooks = upsertHook({}, hook({ enabled: true }))
    expect(setHookEnabled(hooks, 'h1', false).PreToolUse?.[0]?.enabled).toBe(false)
    expect(setHookEnabled(hooks, 'h1', true).PreToolUse?.[0]).not.toHaveProperty('enabled')
  })

  it('toFileEntry 把毫秒写回秒', () => {
    expect(toFileEntry(hook({ timeoutMs: 45_000 })).timeout).toBe(45)
  })

  it('★ 给手写的条目补 id —— 没有稳定的键，开关就会点到别人身上', () => {
    const hooks = normalizeLocalSettings({
      hooks: { PreToolUse: [{ command: 'no-id-here' }] }
    }).hooks
    expect(hooks.PreToolUse?.[0]?.id).toBe('')
    let n = 0
    const filled = assignIds(hooks, () => `minted-${String(++n)}`)
    expect(filled.PreToolUse?.[0]?.id).toBe('minted-1')
  })

  it('已经有 id 的不重铸', () => {
    const hooks = normalizeLocalSettings({ hooks: { PreToolUse: [{ id: 'keep', command: 'x' }] } }).hooks
    expect(assignIds(hooks, () => 'new').PreToolUse?.[0]?.id).toBe('keep')
  })
})

describe('prompt 型钩子', () => {
  const norm = (raw: unknown): HookSettings => normalizeLocalSettings({ hooks: raw }).hooks

  it('★ 老文件（一条 type 都没有）仍然解析成 command —— 缺省值不能换', () => {
    const list = hookListFrom(norm({ Stop: [{ id: 'a', command: 'x' }] }), 'global', '/p')
    expect(list[0]?.type).toBe('command')
  })

  it('prompt 型读得进来，默认超时是 30 秒（独立于命令钩子那条 60 秒）', () => {
    const list = hookListFrom(norm({ Stop: [{ id: 'a', type: 'prompt', prompt: '达成了吗' }] }), 'global', '/p')
    const row = list[0]
    expect(row?.type).toBe('prompt')
    expect(row?.timeoutMs).toBe(30_000)
    expect(row !== undefined && row.type === 'prompt' ? row.prompt : '').toBe('达成了吗')
  })

  it('★ prompt 型缺 prompt 被丢掉 —— 不造一条永远跑不起来的条目', () => {
    expect(hookListFrom(norm({ Stop: [{ id: 'a', type: 'prompt' }] }), 'global', '/p')).toEqual([])
    expect(hookListFrom(norm({ Stop: [{ id: 'a', type: 'prompt', prompt: '   ' }] }), 'global', '/p')).toEqual([])
  })

  it('command 型缺 command 同样被丢掉', () => {
    expect(hookListFrom(norm({ Stop: [{ id: 'a', type: 'command' }] }), 'global', '/p')).toEqual([])
  })

  it('认不出的 type 丢掉这一条，不按 command 读', () => {
    expect(hookListFrom(norm({ Stop: [{ id: 'a', type: 'webhook', command: 'x' }] }), 'global', '/p')).toEqual([])
  })

  it('★ 读写互逆：prompt 型写回去再读回来是同一条', () => {
    const original: HookDefinition = {
      id: 'g1',
      type: 'prompt',
      event: 'Stop',
      prompt: '只有当 README 的版本号与 package.json 一致时才算达成',
      model: 'sonnet',
      modelProviderId: 'p1',
      enabled: true,
      timeoutMs: 30_000
    }
    const roundTripped = hookListFrom(norm({ Stop: [toFileEntry(original)] }), 'global', '/p')[0]
    expect(roundTripped).toMatchObject(original)
  })

  it('command 型写回去**不带 type** —— 缺省即它，写上去会把老文件重排一遍', () => {
    expect(toFileEntry(hook())).not.toHaveProperty('type')
  })

  it('★ 只配了供应商没配别名时供应商被丢掉 —— 那配不出任何一条绑定', () => {
    const list = hookListFrom(
      norm({ Stop: [{ id: 'a', type: 'prompt', prompt: 'x', modelProviderId: 'p1' }] }),
      'global',
      '/p'
    )
    expect(list[0]).not.toHaveProperty('modelProviderId')
  })
})
