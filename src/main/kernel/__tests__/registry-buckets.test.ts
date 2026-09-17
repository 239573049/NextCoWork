/**
 * 三张注册表的**工作区分桶**。
 *
 * 这一组守的是一类**没有任何症状**的错误:两个工作区同时有事发生时,后扫的
 * 那一份会把先扫的整个换掉,于是 A 的这一轮拿到 B 的 Skill 目录 / 子代理清单 /
 * 模式定义 —— 提示词照发、界面照画,只是内容属于另一个工作区。
 *
 * 所以每条用例的形状都一样:**装完 B 再回头查 A**。少了「回头查」那一步,
 * 用例就退化成「装得进去吗」,而那从来不是出问题的地方。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { AgentDefinition } from '../../../shared/domain/agent-def'
import type { ModeDefinition } from '../../../shared/domain/mode'
import type { Skill } from '../../../shared/domain/skill'
import { agentRegistry, resetAgentRegistries } from '../agent/registry'
import { modeRegistry, resetModeRegistries } from '../mode/registry'
import { skillRegistry, resetSkillRegistries } from '../skill/registry'
import { RegistryBuckets, MAX_REGISTRY_BUCKETS } from '../registry-buckets'

const skill = (name: string): Skill => ({
  id: name,
  name,
  description: `${name} 的描述`,
  category: '未分类',
  source: { kind: 'folder', path: `/w/.next-cowork/skills/${name}/SKILL.md` },
  globalEnabled: true,
  frontmatter: {},
  body: '正文'
})

const agent = (name: string): AgentDefinition => ({
  name,
  description: `${name} 的描述`,
  prompt: '你只看,不改。',
  source: { kind: 'project', path: `/w/.next-cowork/agents/${name}.md` }
})

const mode = (id: string): ModeDefinition => ({
  id,
  name: id,
  description: `${id} 的描述`,
  prompt: '按这个来。',
  source: { kind: 'project', path: `/w/.next-cowork/modes/${id}.md` }
})

beforeEach(() => {
  resetSkillRegistries()
  resetAgentRegistries()
  resetModeRegistries()
})

describe('Skill 注册表 · 分桶', () => {
  it('★ 两个工作区各装各的,装完 B 再查 A 拿到的还是 A 那份', () => {
    skillRegistry('ws-a').replaceAll({ skills: [skill('commit')], diagnostics: [] })
    skillRegistry('ws-b').replaceAll({ skills: [skill('deploy')], diagnostics: [] })

    expect(skillRegistry('ws-a').list().map((s) => s.name)).toEqual(['commit'])
    expect(skillRegistry('ws-b').list().map((s) => s.name)).toEqual(['deploy'])
    expect(skillRegistry('ws-a').get('deploy')).toBeUndefined()
  })

  it('没扫过的工作区是空的,不是别人的那份', () => {
    skillRegistry('ws-a').replaceAll({ skills: [skill('commit')], diagnostics: [] })
    expect(skillRegistry('ws-c').list()).toEqual([])
  })

  it('诊断也跟着桶走', () => {
    skillRegistry('ws-a').replaceAll({ skills: [], diagnostics: [{ path: '/a', message: '坏了' }] })
    expect(skillRegistry('ws-b').diagnostics()).toEqual([])
  })

  it('★ 换账户时整体清空 —— 留一桶就是一次跨账户串味', () => {
    skillRegistry('ws-a').replaceAll({ skills: [skill('commit')], diagnostics: [] })
    resetSkillRegistries()
    expect(skillRegistry('ws-a').list()).toEqual([])
  })
})

describe('子代理注册表 · 分桶', () => {
  it('★ 两个工作区各装各的', () => {
    agentRegistry('ws-a').replaceAll({ agents: [agent('researcher')], diagnostics: [] })
    agentRegistry('ws-b').replaceAll({ agents: [agent('reviewer')], diagnostics: [] })

    expect(agentRegistry('ws-a').names()).toEqual(['researcher'])
    expect(agentRegistry('ws-b').names()).toEqual(['reviewer'])
  })

  it('★ 新桶出厂就带内建那条 —— 「至少有一个子代理可派」在每个工作区都成立', () => {
    expect(agentRegistry('ws-fresh').names()).toContain('general-purpose')
  })
})

describe('模式注册表 · 分桶', () => {
  it('★ 两个工作区各装各的', () => {
    modeRegistry('ws-a').replaceAll({ modes: [mode('review')], diagnostics: [] })
    modeRegistry('ws-b').replaceAll({ modes: [mode('triage')], diagnostics: [] })

    expect(modeRegistry('ws-a').list().map((m) => m.id)).toEqual(['review'])
    expect(modeRegistry('ws-b').list().map((m) => m.id)).toEqual(['triage'])
  })

  it('★ 解析不到就兜底到内建 code,不会掉到另一个工作区的自定义模式上', () => {
    modeRegistry('ws-a').replaceAll({ modes: [mode('review')], diagnostics: [] })
    expect(modeRegistry('ws-b').resolve('review').id).toBe('code')
  })
})

describe('RegistryBuckets 本身', () => {
  it('同一个 id 拿到的是同一份', () => {
    const buckets = new RegistryBuckets(() => ({ n: 0 }))
    buckets.get('a').n = 1
    expect(buckets.get('a').n).toBe(1)
  })

  it('★ 超出上限时淘汰最久未用的那个,而不是最近的那个', () => {
    const buckets = new RegistryBuckets(() => ({ n: 0 }), 2)
    buckets.get('a')
    buckets.get('b')
    // 再碰一次 a,让 b 成为最久未用
    buckets.get('a')
    buckets.get('c')

    expect(buckets.size()).toBe(2)
    expect(buckets.has('a')).toBe(true)
    expect(buckets.has('b')).toBe(false)
    expect(buckets.has('c')).toBe(true)
  })

  it('drop 只丢一个,clear 全丢', () => {
    const buckets = new RegistryBuckets(() => ({ n: 0 }))
    buckets.get('a')
    buckets.get('b')
    buckets.drop('a')
    expect(buckets.has('a')).toBe(false)
    expect(buckets.has('b')).toBe(true)
    buckets.clear()
    expect(buckets.size()).toBe(0)
  })

  it('默认上限远大于「一个人同时开着几个工作区」', () => {
    expect(MAX_REGISTRY_BUCKETS).toBeGreaterThanOrEqual(32)
  })
})
