/**
 * 快捷键分发 —— 一条全局 keydown,按注册表分发。
 *
 * ## 为什么要收成一条
 *
 * 在这之前,`AppShell.tsx` 里有一个只认「打开设置」那一个组合键的孤立
 * keydown。再加一个快捷键就是再加一个 `document.addEventListener`,
 * 而那条路上会有三件事悄悄出错:
 *
 * 1. **顺序不确定**。两个监听器都想吃同一个组合键时,谁先注册谁先跑,
 *    而注册顺序取决于组件挂载顺序 —— 也就是取决于用户打开了哪些面板。
 * 2. **输入框里也会触发**。每个监听器都得自己记着判断 `target`,漏一个
 *    就是「在输入框里打字触发了一个命令」。
 * 3. **冲突看不见**。插件抢了一个内置组合键时,没有任何地方会说出来。
 *
 * 收成一条之后这三件事各有一个明确的答案:注册表顺序即优先级、
 * 可编辑元素里一律不触发、冲突时**内置胜出**。
 */
import { useEffect } from 'react'
import { matchesAccelerator } from '../lib/accelerator'
import type { Command } from './commands'

/**
 * 这个事件该被快捷键吃掉吗。
 *
 * ★ 可编辑元素里**一律不触发**:用户在聊天输入框里按 `⌘N` 的意图有可能是
 * 「新建对话」,但在代码编辑器里按同样的键几乎一定不是。分不清的时候,
 * 不动比动对 —— 少一次触发只是少一次便利,多一次触发会毁掉正在打的一段字。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  /*
    ★ **按属性判断,不用 `instanceof HTMLElement`。** 两个理由:

    1. 跨 realm 的元素 `instanceof` 是 `false` —— 而这个应用里现在真的有
       别的 realm(插件 iframe、浏览器视图)。用 instanceof 的话,
       一个来自 iframe 的输入框会被当成「不是输入框」。
    2. `vitest` 跑在 node 环境里,那儿根本没有 `HTMLElement`,
       一个纯判断函数不该因此测不了。
  */
  if (target === null || typeof target !== 'object') return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  if (element.isContentEditable === true) return true
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 命令 → 组合键的分发表。
 *
 * ★ **同一个组合键只落到第一条命令上**,而注册表里内置排在插件前面
 * (见 `mergeCommands`)—— 于是插件抢不走一个已经被内置占着的组合键。
 * 抢得走的话,装一个插件就能让 `⌘N` 不再是「新建对话」,而用户完全不知道
 * 是谁改的。
 */
export function buildKeymap(commands: readonly Command[]): Map<string, Command> {
  const map = new Map<string, Command>()
  for (const command of commands) {
    if (command.accelerator === undefined) continue
    const key = command.accelerator.toLowerCase()
    if (map.has(key)) continue
    map.set(key, command)
  }
  return map
}

export function useCommandShortcuts(commands: readonly Command[]): void {
  useEffect(() => {
    const keymap = buildKeymap(commands)
    if (keymap.size === 0) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return
      for (const [accelerator, command] of keymap) {
        if (!matchesAccelerator(accelerator, event)) continue
        event.preventDefault()
        void command.run()
        return
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [commands])
}
