/**
 * Z.AI 渠道(GLM Coding Plan)—— ZCode 两条渠道里**唯一被实测印证过**的那条。
 *
 * 实现在 `zcode.ts`,那里写着完整的链路和证据等级。这个文件只有数据。
 *
 * ★★ 2026-09-15 起主路径是**服务端发起 + 双通道**(`cli` 字段);下面那批
 * 旧字段(authorizeUrl / redirect 9999 / …)整体转为 **fallback 配置** —— init
 * 失败时降级用的,数据一行没删。平时登录不再碰 9999 端口,和用户机器上真在
 * 跑的 ZCode CLI 不再打架。
 */
import { createZcodeSpec } from './zcode'
import type { OAuthProviderSpec } from '../registry'

/**
 * ★ ZCode 的公开 appId(public client,没有 client_secret)。
 * 它和下面的 redirect 是一对 —— 见 `zcode.ts` 文件头关于「我们对上游自称是 ZCode」那段。
 */
const CLIENT_ID = 'client_P8X5CMWmlaRO9gyO-KSqtg'

/**
 * ★★ **`127.0.0.1` 不能写成 `localhost`。** redirect_uri 要**逐字节**等于该 client
 * 注册的那个值,而 ZCode CLI 注册的是 `http://127.0.0.1:9999/callback`。
 * 2026-09-09 实测:authorize 阶段对 redirect_uri **完全不校验**(三种写法一律放行),
 * 所以写错了没有任何早期信号 —— 只会在**换 token 那一步**炸,且错误信息不提它。
 *
 * ★ 只在 fallback 时才会真的占用这个端口。
 */
const REDIRECT_PORT = 9999
const REDIRECT_PATH = '/callback'

export const ZCODE_ZAI_OAUTH: OAuthProviderSpec = createZcodeSpec({
  id: 'zcode-zai',
  label: 'Z.AI',
  authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
  tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
  provider: 'zai',
  tokenKey: 'zai',
  clientId: CLIENT_ID,
  /*
    ★★ 主路径的服务端发起流程。`redirect_uri` 这个参数名是 2026-09-15 逆向
    ZCode.app v3.11.2 确认的:官方客户端对 zai 渠道覆盖的是 `redirect_uri`
    (bigmodel 那条覆盖的是 `redirect`,两家不一样)。
  */
  cli: {
    initUrl: 'https://zcode.z.ai/api/v1/oauth/cli/init',
    redirectParam: 'redirect_uri'
  },
  redirect: {
    kind: 'loopback-fixed',
    port: REDIRECT_PORT,
    path: REDIRECT_PATH,
    host: '127.0.0.1'
  },
  businessLoginUrl: 'https://api.z.ai/api/auth/z/login',
  userinfoUrl: 'https://chat.z.ai/api/oauth/userinfo'
})
