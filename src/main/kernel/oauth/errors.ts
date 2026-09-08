/**
 * OAuth 流程的两类结局 —— **单独一个文件,不在 `flow.ts` 里。**
 *
 * ★★ 理由是依赖方向:各家的 issuer(`issuers/*.ts`)在自己的钩子里要抛
 * `OAuthFailedError`,而 `flow.ts` 依赖 `registry.ts`、`registry.ts` 又依赖
 * issuers —— 让 issuer 反过来 import `flow.ts` 就成了一个环。环在 ESM 下
 * 多半能跑,但**表现是随模块求值顺序变的 `undefined`**,而那种崩溃发生在
 * `instanceof` 上,错误信息只会说 "Right-hand side of 'instanceof' is not callable"。
 * 把这两个类放在依赖图的叶子上,环从结构上就不存在。
 *
 * ★ `flow.ts` 原样 re-export 这两个名字,所以既有的 import 路径一个都不用改。
 */

/** 用户放弃(关掉授权页 / 点了取消 / 超时)。**不是故障**,上层据此不报错误红条 */
export class OAuthAbandonedError extends Error {
  constructor(readonly kind: 'cancelled' | 'timeout') {
    super(kind === 'timeout' ? '授权超时' : '已取消登录')
    this.name = 'OAuthAbandonedError'
  }
}

/** 授权服务器明确拒绝,或者回来的东西不对 */
export class OAuthFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthFailedError'
  }
}
