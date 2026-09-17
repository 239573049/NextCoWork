/**
 * 命令注册表与快捷键分发。
 *
 * 这一组守的两条规则都是**冲突时谁赢**,而冲突在开发机上几乎不会自然发生 ——
 * 它要等到用户装了那个恰好抢同一个组合键的插件才出现,那时候没人查得出来
 * 是哪个插件干的。所以它们只能被测试钉住。
 */
import { describe, expect, it } from 'vitest'
import { mergeCommands, type Command } from '../commands'
import { buildKeymap, isTypingTarget } from '../useCommandShortcuts'

const command = (over: Partial<Command> = {}): Command => ({
  id: 'builtin.openSettings',
  titleKey: 'feature.settings',
  icon: 'settings',
  run: () => {},
  ...over
})

describe('命令合并', () => {
  it('★ 同 id 时内置胜出 —— 命令面板里的条目不能被冒名', () => {
    const builtin = [command({ titleKey: 'feature.settings' })]
    const plugin = [command({ titleKey: 'plugin.acme.demo.fake', pluginId: 'acme.demo' })]
    const merged = mergeCommands(builtin, plugin)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.pluginId).toBeUndefined()
  })

  it('不同 id 的插件命令进得来,而且排在内置之后', () => {
    const merged = mergeCommands(
      [command()],
      [command({ id: 'acme.demo:hello', pluginId: 'acme.demo' })]
    )
    expect(merged.map((c) => c.id)).toEqual(['builtin.openSettings', 'acme.demo:hello'])
  })
})

describe('快捷键分发', () => {
  it('★ 同一个组合键只落到第一条命令上 —— 内置在前,插件抢不走', () => {
    const keymap = buildKeymap([
      command({ accelerator: 'CmdOrCtrl+N' }),
      command({ id: 'acme.demo:hello', accelerator: 'CmdOrCtrl+N', pluginId: 'acme.demo' })
    ])
    expect(keymap.size).toBe(1)
    expect(keymap.get('cmdorctrl+n')?.pluginId).toBeUndefined()
  })

  it('大小写不影响匹配 —— 清单里怎么写的都认', () => {
    const keymap = buildKeymap([command({ accelerator: 'cmdorctrl+K' })])
    expect(keymap.has('cmdorctrl+k')).toBe(true)
  })

  it('没有组合键的命令不进分发表', () => {
    expect(buildKeymap([command()]).size).toBe(0)
  })

  it('★ 可编辑元素里一律不触发 —— 多一次触发会毁掉正在打的一段字', () => {
    const target = (over: Record<string, unknown>): EventTarget => over as unknown as EventTarget
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      expect(isTypingTarget(target({ tagName: tag })), tag).toBe(true)
    }
    expect(isTypingTarget(target({ tagName: 'DIV', isContentEditable: true }))).toBe(true)
    expect(isTypingTarget(target({ tagName: 'DIV' }))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('★ 跨 realm 的元素也认得出来 —— 插件 iframe 里的输入框不是「不是输入框」', () => {
    // instanceof 在跨 realm 时是 false;这个函数按属性判断,所以不受影响。
    const fromIframe = Object.create(null) as Record<string, unknown>
    fromIframe.tagName = 'TEXTAREA'
    expect(isTypingTarget(fromIframe as unknown as EventTarget)).toBe(true)
  })
})
