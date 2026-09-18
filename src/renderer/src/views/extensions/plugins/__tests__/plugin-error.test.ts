/**
 * 插件错误 key 的收窄。
 *
 * 这条测试挡的是两个方向的漂移:
 * - **主进程加了新 key、这里没跟** → 新错误落进兜底文案,用户看不到具体原因;
 * - **这里多写了一个不存在的 key** → `t()` 返回 key 本身,界面漏出内部标识,
 *   而那正是这个文件被抽出来要修的那个 bug。
 *
 * 所以下面直接去读主进程的源码,把里面抛出的 `plugins.*` key 抓出来比对 ——
 * 抄一份名单进测试只会得到第三份会分叉的表。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginErrorKey } from '../plugin-error'
import { PLUGIN_METHOD_PERMISSION } from '../../../../../../shared/plugin/protocol'

const MAIN = join(__dirname, '../../../../../../main')

function keysThrownByMain(): Set<string> {
  const found = new Set<string>()
  for (const file of ['ipc/plugin-market.ts', 'ipc/plugins.ts', 'plugin/manager.ts']) {
    const source = readFileSync(join(MAIN, file), 'utf8')
    for (const match of source.matchAll(/['"](plugins\.[a-zA-Z.]+)['"]/g)) {
      const key = match[1]
      // ★ `plugins.*` 也是协议标识符的命名空间(第 5 层):`plugins.invoke` 等是 **RPC 方法名**,
      // `plugins.event` 是**反向调用 kind**。它们都不是抛给用户的错误 key —— 按方法表 +
      // 这一个 kind 排除,别当错误 key 比对。
      if (key !== undefined && key !== 'plugins.event' && !Object.hasOwn(PLUGIN_METHOD_PERMISSION, key)) found.add(key)
    }
  }
  return found
}

describe('pluginErrorKey', () => {
  it('认得出的 key 原样返回', () => {
    expect(pluginErrorKey(new Error('plugins.authRequired'))).toBe('plugins.authRequired')
    expect(pluginErrorKey(new Error('plugins.scopeRequired'))).toBe('plugins.scopeRequired')
    expect(pluginErrorKey(new Error('plugins.notRunning'))).toBe('plugins.notRunning')
  })

  it('带诊断后缀的状态码同样是认得出的 key', () => {
    // 主进程为了排查把 HTTP 状态拼在 key 后面,比如 `plugins.marketFailed:404`。
    // 按整串比对的话它会掉进兜底分支,而「市场不可用」正是最该说清的那条。
    expect(pluginErrorKey(new Error('plugins.marketFailed:404'))).toBe('plugins.marketFailed')
    expect(pluginErrorKey(new Error('plugins.marketFailed:500'))).toBe('plugins.marketFailed')
  })

  it('认不出的一律落兜底,绝不把内部标识漏到界面', () => {
    expect(pluginErrorKey(new Error('plugins.someFutureKey'))).toBe('plugins.operationFailed')
    expect(pluginErrorKey(new Error('ENOENT: no such file'))).toBe('plugins.operationFailed')
    expect(pluginErrorKey(undefined)).toBe('plugins.operationFailed')
    expect(pluginErrorKey('not an error')).toBe('plugins.operationFailed')
  })

  it('★ 主进程抛出的每个 key 都必须认得出来', () => {
    const missing = [...keysThrownByMain()].filter(
      (key) => pluginErrorKey(new Error(key)) === 'plugins.operationFailed'
    )
    expect(missing).toEqual([])
  })
})
