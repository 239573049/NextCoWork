/**
 * 各家 issuer 都要用的三件小工具。
 *
 * ★ 单独放一处不是为了「减少重复」这种审美理由 —— `decodeJwtPayload` 里
 * `base64url` 那个编码名一旦写成 `base64`,解出来的多半仍然是一段能 JSON.parse
 * 的东西(padding 和 `-_` 只在少数 payload 上才出现差异),于是**大部分账号能登、
 * 少数账号登不上**,而报错只说「授权信息不完整」。这种坑只该有一份。
 */

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** ★ 空串一律当没有 —— 上游用 `""` 表示「没有」的情况比想象中多 */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 读一个 JWT 的 payload。
 *
 * ★★ **不验签,这是有意的。** 这个 token 是我们自己发起的流程、经 TLS 从令牌
 * 端点**直接**拿回来的;我们从里面只读账号 id 和显示用的字段,没有把信任委托给
 * 第三方,也没有拿它当授权凭据 —— 真正的授权由上游对 token 自己校验。加一套
 * JWKS 拉取只会引入一个「网络不通就登不上」的新故障点,换不到任何实际保证。
 *
 * ★ 解不开一律返回 `undefined`,不抛:登录成不成的判据是**取没取到必需字段**,
 * 而那个判断在各家的 `identity()` 里,一处就够。
 */
export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) return undefined
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}
