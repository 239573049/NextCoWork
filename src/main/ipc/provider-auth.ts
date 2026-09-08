/**
 * 账号登录的编排 —— **整条链路上唯一碰 Electron 的一环。**
 *
 * 流程本身(PKCE、回环服务器、换 token、提账号身份)全在 `kernel/oauth/` 和
 * `net/oauth-loopback.ts` 里,零 Electron、可直测。这里只做四件事:
 * 查规格、把 `shell.openExternal` 和 `host.fetch` 注入进去、把结果落库、广播。
 */
import { shell } from 'electron'
import type { CredentialInfo } from '../../shared/domain/provider'
import { serializeCredential } from '../../shared/domain/credential'
import { findPreset } from '../../shared/domain/presets'
import { removeCredential } from '../db/repo'
import {
  OAuthAbandonedError,
  OAuthFailedError,
  runOAuthFlow,
  type OAuthPhase
} from '../kernel/oauth/flow'
import { oauthSpecOf, type OAuthProviderSpec } from '../kernel/oauth/registry'
import { PortBusyError } from '../net/oauth-loopback'
import { ensureSeeded, getHost } from '../runtime'
import { store } from '../state/store'
import { windows } from '../window/registry'
import { IpcError } from './errors'
import { getCredentialInfo } from './provider'

interface ActiveFlow {
  providerId: string
  abort: AbortController
  /** `manual-paste` 形态下,把用户粘回来的 code 交给正在等的那个 flow */
  submitCode?: (code: string) => void
}

/**
 * ★ **单飞。** 同一时刻只允许一条登录在跑,再次发起时**先掐掉上一条**。
 *
 * 不报「已有登录正在进行中」:那句话最常见的触发原因是用户手抖点了两下按钮,
 * 而他会因此以为登录失败了。掐掉重来是他期望的行为 —— 旧的那条本来也没人在等。
 */
let active: ActiveFlow | null = null

function resolveSpec(providerId: string): { spec: OAuthProviderSpec; credentialRef: string } {
  ensureSeeded()
  const provider = store.listProviders().find((p) => p.id === providerId)
  if (provider === undefined) throw new IpcError('unknown', `没有这个供应商:${providerId}`)

  /*
    ★ 「这家走不走 OAuth」查的是**预设**,不是凭证 —— 还没登录时凭证是空的,
    照凭证判会把一家 OAuth 供应商在未登录状态下认成 API Key 供应商,
    于是界面画出一个填了也没用的密钥框。
  */
  const issuer = findPreset(providerId)?.oauthIssuer
  if (issuer === undefined) {
    throw new IpcError('unknown', `供应商「${provider.name}」不支持账号登录`)
  }
  return { spec: oauthSpecOf(issuer), credentialRef: provider.credentialRef }
}

function emitPhase(providerId: string, phase: OAuthPhase, message?: string): void {
  windows.emitToAll('provider:authProgress', {
    providerId,
    phase,
    ...(message === undefined ? {} : { message })
  })
}

async function announce(providerId: string): Promise<CredentialInfo> {
  const info = await getCredentialInfo(providerId)
  windows.emitToAll('provider:authChanged', { providerId, info })
  return info
}

/**
 * 把内部异常翻译成人话。
 *
 * ★ 端口占用单独一句:它是唯一一个**用户自己能解决**的失败,而通用的
 * 「登录失败」完全不指向那个解法(去关掉正在跑的 codex login)。
 */
function translate(err: unknown): IpcError {
  if (err instanceof PortBusyError) {
    return new IpcError(
      'unknown',
      `本机 ${err.port} 端口被占用 —— Codex CLI 的登录用的是同一个端口。` +
        '请先结束正在进行的 codex login，或关掉占用该端口的程序后重试。'
    )
  }
  if (err instanceof OAuthAbandonedError) {
    return new IpcError(
      'unknown',
      err.kind === 'timeout' ? '授权超时（5 分钟），请重试' : '已取消登录'
    )
  }
  if (err instanceof OAuthFailedError) return new IpcError('auth', err.message)
  return new IpcError('unknown', err instanceof Error ? err.message : String(err))
}

export async function startOAuth(providerId: string): Promise<CredentialInfo> {
  const { spec, credentialRef } = resolveSpec(providerId)

  active?.abort.abort()
  const abort = new AbortController()
  const flow: ActiveFlow = { providerId, abort }
  active = flow

  try {
    const cred = await runOAuthFlow({
      spec,
      // ★ 用 host.fetch(Electron 的 net.fetch)而不是全局 fetch:它走 Chromium
      //   网络栈,于是设置页那份代理配置对换 token 这一步一样生效
      fetch: getHost().fetch,
      now: () => getHost().clock.now(),
      /*
        ★ **不复用 `ipc/app.ts` 的 openExternal。** 那条是渲染层能直接调的通道;
        授权 URL 带着我们自己生成的 state,不该从渲染层过一遍手 —— 那等于把
        CSRF 防线交给了它。这里直接用 shell,`src/main/ipc/` 本来就允许碰 Electron。
      */
      openBrowser: (url) => shell.openExternal(url),
      onPhase: (phase) => emitPhase(providerId, phase),
      signal: abort.signal,
      awaitPastedCode: () =>
        new Promise<string>((resolve) => {
          flow.submitCode = resolve
          abort.signal.addEventListener('abort', () => resolve(''), { once: true })
        })
    })

    /*
      ★ 落库在广播之前。反过来的话,渲染层收到 authChanged 去查 getCredentialInfo,
      读到的还是上一次的状态 —— 一次「登录成功但界面显示未登录」的假故障。

      ★ 没有系统密钥环时 `secrets.set` 会抛(不做明文降级),异常照常上抛翻译成人话。
    */
    await getHost().secrets.set(credentialRef, serializeCredential(cred))
    return await announce(providerId)
  } catch (err) {
    const translated = translate(err)
    emitPhase(
      providerId,
      err instanceof OAuthAbandonedError ? 'cancelled' : 'failed',
      translated.message
    )
    throw translated
  } finally {
    if (active === flow) active = null
  }
}

export function cancelOAuth(providerId: string): void {
  if (active?.providerId === providerId) active.abort.abort()
}

export function submitOAuthCode(providerId: string, code: string): Promise<CredentialInfo> {
  const flow = active
  if (flow?.providerId !== providerId || flow.submitCode === undefined) {
    throw new IpcError('unknown', '当前没有等待授权码的登录流程')
  }
  flow.submitCode(code)
  // 真正的终态由那条还在跑的 startOAuth 给,这里只回一个当前快照
  return getCredentialInfo(providerId)
}

/**
 * 退出登录。
 *
 * ★★ 走 `db/repo` 的 `removeCredential`,**不是** `secrets.set(ref, '')` ——
 * 后者会先过 `isEncryptionAvailable()`,在没有系统密钥环的机器上直接抛错,
 * 于是「退出登录」这件本该**总能成功**的事会在那类机器上失败。删密文不需要加密能力。
 * (和 `removeProvider` 里那条注释是同一个理由。)
 */
export async function signOut(providerId: string): Promise<CredentialInfo> {
  const { credentialRef } = resolveSpec(providerId)
  if (active?.providerId === providerId) active.abort.abort()
  removeCredential(credentialRef)
  return announce(providerId)
}

/**
 * 刷新 token 时凭证被改写(或被标成需要重新登录)——把这件事推给可能正开着设置页的用户。
 *
 * ★ 内核里的 `CredentialResolver` 拿不到 `windows`,所以是**注入回调**,
 * 和 `onUsageAttempt` 完全同一个套路。装配在 `ipc/index.ts`。
 */
export function announceCredentialRef(credentialRef: string): void {
  const provider = store.listProviders().find((p) => p.credentialRef === credentialRef)
  if (provider === undefined) return
  void announce(provider.id).catch(() => {
    /* 广播失败不该影响那条正在跑的请求 */
  })
}
