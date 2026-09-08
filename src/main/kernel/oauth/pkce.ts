/**
 * PKCE(RFC 7636)—— 三个纯函数,没有任何 I/O。
 *
 * ## 为什么桌面应用必须用它
 *
 * 我们是 **public client**:没有 client_secret 可言(打包进应用的秘密不是秘密)。
 * 于是「拿着授权码去换 token」这一步谁都能做 —— 只要他能截到那个码。PKCE 补的
 * 就是这个:发起授权时先把 `sha256(verifier)` 交上去,换 token 时再出示 `verifier`,
 * 截到码的人没有 verifier,码对他没用。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface Pkce {
  verifier: string
  challenge: string
  method: 'S256'
}

/**
 * ★ **必须是 `randomBytes`,不能是 `Math.random`。**
 * `Math.random` 的输出是可预测的(V8 用的是 xorshift128+,观察到几个输出就能
 * 反推内部状态)。verifier 可预测 = PKCE 整个失效;state 可预测 = CSRF 防线整个失效。
 * 这两处是本文件仅有的两个随机源,也是它存在的全部理由。
 */
function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/** RFC 7636 §4.1:verifier 是 43–128 个 unreserved 字符。64 字节 base64url = 86 字符 */
export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(64))
  return { verifier, challenge: codeChallengeOf(verifier), method: 'S256' }
}

/**
 * RFC 7636 §4.2。单独导出是为了能对规范附录 B 的**已知向量**做断言 ——
 * 这个变换错一位,表现是换 token 时一个不说明原因的 `invalid_grant`。
 */
export function codeChallengeOf(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest())
}

export function randomState(): string {
  return base64url(randomBytes(32))
}

/**
 * 比对回调里带回来的 state。
 *
 * ★ 用 `timingSafeEqual` 而不是 `===`:这是一个跨进程边界、由外部输入触发的比较,
 * 定时侧信道在这类比较上是真实存在的。长度不等必须先短路 —— `timingSafeEqual`
 * 对不等长的 Buffer 会**抛**,而那个异常会变成一次登录失败而不是一次「state 不对」。
 */
export function stateMatches(expected: string, received: string | null | undefined): boolean {
  if (received === null || received === undefined) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
