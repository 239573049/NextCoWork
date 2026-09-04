/**
 * 「配置 + 有没有 Key」的合成 —— **这一层刻意不认识 electron**。
 *
 * 它被两处消费:`ipc/websearch.ts`(下发给界面)和 `runtime.ts` 里那个装给
 * `search/service.ts` 的访问器。后者是它必须住在这里、而不是留在 `ipc/` 里的原因:
 *
 * `runtime.ts` 有一条铁律是**零 electron import**(它自己的文件头写着),
 * 而 `ipc/websearch.ts` 要 `windows.emitToAll` 广播,所以那个文件拖着 electron。
 * 从 runtime 去 import 它,`agent-pump.test.ts` 与 `agent-run.test.ts` 那条
 * 无头链路当场断 —— 而那两个测试正是这条铁律的守卫。
 *
 * 所以:能共用的那一半(读库、逐家问密钥环)在这里,广播留在 `ipc/`。
 */
import type { KernelHost } from '../kernel/host'
import type { SearchProviderStatus } from '../../shared/domain/search'
import { searchSecretRef } from '../../shared/domain/search'
import { store } from '../state/store'

/**
 * 末四位。太短的 Key 全打码 —— 一个 5 位的 Key 显示末四位等于显示了它。
 */
export function last4Of(key: string): string | undefined {
  return key.length >= 8 ? key.slice(-4) : undefined
}

/**
 * 逐家读一次密钥环。八次 `safeStorage.decryptString` 在一次列表刷新里是
 * 可以接受的(本地、微秒级),而缓存「谁有 Key」的代价是:用户在另一个窗口
 * 清了 Key,这个窗口还显示着「已配置」—— 一个会骗人的缓存。
 */
export async function searchStatuses(
  secrets: KernelHost['secrets']
): Promise<SearchProviderStatus[]> {
  const configs = store.listSearchProviders()
  return Promise.all(
    configs.map(async (config) => {
      const key = await secrets.get(searchSecretRef(config.id))
      return {
        config,
        hasKey: key !== null && key !== '',
        last4: key === null ? undefined : last4Of(key)
      }
    })
  )
}
