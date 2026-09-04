/**
 * KernelHost 的 Electron 实现 —— **electron 只在这里泄漏**(方案 §2 的拓扑图)。
 *
 * `host.ts` 已经把 `nodeHost()` 定义成真实默认值,所以这里只覆盖三项:
 *
 * | 端口 | 为什么非 Electron 不可 |
 * |---|---|
 * | `paths`   | `app.getPath('userData')` 是各平台约定目录的唯一权威 |
 * | `secrets` | `safeStorage` 用的是系统钥匙串,没有纯 Node 的等价物 |
 * | `fetch`   | `net.fetch` 走 Chromium 网络栈,于是 `net/proxy.ts` 那一次 `setProxy` 对全应用的出站请求一起生效 |
 *
 * 其余端口(clock / logger / fs / spawn)在 Electron 里和在 Node 里是同一件事,
 * 覆盖它们只会多一份要同步维护的代码。
 */
import { app, net, safeStorage } from 'electron'
import { getCredential, putCredential } from '../db/repo'
import type { KernelHost } from '../kernel/host'
import { nodeHost } from '../kernel/host'
import { withDemo } from '../kernel/upstream/demo'

/**
 * safeStorage 版的凭证存取。
 *
 * 密文落在 `credentials` 表里(`db/schema.ts`)。**换掉的只是那个 Map,
 * 加解密逻辑一行没动**:进出数据库的从头到尾都是 `encryptString` 的产物,
 * 明文一次都没离开过这两个函数 —— 方案 §9 的「只写不读」就是这个意思。
 */
function electronSecrets(): KernelHost['secrets'] {
  return {
    get: async (ref) => {
      const blob = getCredential(ref)
      // 表里存的是 Uint8Array,decryptString 要 Buffer —— 这一层转换刻意留在
      // 这里而不是 repo 里:数据库层不 import electron 的任何东西
      return blob === undefined ? null : safeStorage.decryptString(Buffer.from(blob))
    },
    set: async (ref, value) => {
      /**
       * ★ Linux 无 keyring 时 `isEncryptionAvailable()` 返回 false(方案 §9)。
       * 这里**明确拒绝存储并说明原因**,而不是:
       * - 明文存下来 —— 用户以为密钥被系统保护着,其实没有;
       * - 或者静默丢弃 —— 设置页显示「已保存」,下次启动却是空的。
       *
       * 调用方(设置页)据此显示横幅。一个未处理的 false 会变成上面两种之一。
       */
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统密钥环不可用,拒绝存储密钥(明文落盘不是可接受的降级)')
      }
      putCredential(ref, safeStorage.encryptString(value))
    },
    available: () => safeStorage.isEncryptionAvailable()
  }
}

/**
 * `net.fetch` 的签名比 WHATWG fetch 窄一点(不吃 `URL`),补一层适配。
 *
 * 用它而不是全局 fetch,是为了让请求走 Chromium 网络栈:企业证书、系统代理,
 * 以及**设置页那份代理配置** —— 后者不是自动的,由 `net/proxy.ts` 显式
 * `session.defaultSession.setProxy()` 装上去(Chromium 默认只跟随系统代理)。
 * 全局 fetch 走的是 Node 的网络栈,那三样一样都拿不到。
 */
const electronFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.href : input, init)

export function electronHost(): KernelHost {
  /**
   * ★ `safeStorage` 与 `net.fetch` 都要求 app ready(方案 §9)。早一步调用拿到的是
   * 一个看起来正常、实际不可用的 host,症状会推迟到第一次发请求才出现 ——
   * 那时错误信息里已经没有「调早了」这条线索了。
   */
  if (!app.isReady()) {
    throw new Error('electronHost() 必须在 app.whenReady() 之后调用')
  }
  return withDemo(
    nodeHost({
      paths: {
        userData: () => app.getPath('userData'),
        temp: () => app.getPath('temp')
      },
      secrets: electronSecrets(),
      fetch: electronFetch
    })
  )
}
