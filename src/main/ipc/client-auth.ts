import { shell } from 'electron'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { ClientAuthState, ClientAuthUser, ClientUsageEntry } from '../../shared/domain/client-auth'
import { getHost } from '../runtime'
import { store } from '../state/store'
import { windows } from '../window/registry'
import { CLIENT_PROVIDER_ID } from '../../shared/domain/presets'

const API_ROOT = 'https://nextco.work'
const CLIENT_ID = 'nextcowork-desktop'
const ACCESS_REF = 'nextcowork:client-access-token'
const REFRESH_REF = 'nextcowork:client-refresh-token'
const META_KEY = 'client-auth.meta'
type Meta = { mode: 'offline' | 'authenticated'; user: ClientAuthUser | null; expiresAt: number | null }
let callbackServer: Server | null = null
let refreshTimer: NodeJS.Timeout | null = null
let refreshInFlight: Promise<void> | null = null

function callbackPage(success: boolean): string {
  const title = success ? '登录成功' : '登录未完成'
  const heading = success ? '欢迎回来' : '登录没有完成'
  const detail = success
    ? '你的 NextCoWork 桌面客户端已经连接到账户。现在可以返回应用继续使用。'
    : '授权没有完成，请关闭此页面并回到 NextCoWork 重试。'
  const icon = success ? '✓' : '!'
  const tone = success ? '#78e0a7' : '#f3b36a'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${title} · NextCoWork</title><style>
    :root{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;color:#f4f7f5;background:#151817}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:radial-gradient(ellipse 70% 55% at 50% 25%,#254236 0%,#1a2420 42%,#151817 78%)}
    .orb{position:fixed;width:420px;height:420px;border:1px solid rgba(120,224,167,.11);border-radius:50%;box-shadow:0 0 0 42px rgba(120,224,167,.025),0 0 0 84px rgba(120,224,167,.018);top:-205px;left:50%;transform:translateX(-50%)}
    .card{position:relative;width:min(430px,calc(100vw - 40px));padding:42px 38px 36px;text-align:center;border:1px solid rgba(255,255,255,.11);border-radius:24px;background:rgba(28,34,31,.86);box-shadow:0 24px 80px rgba(0,0,0,.32);backdrop-filter:blur(18px)}
    .mark{width:58px;height:58px;margin:0 auto 24px;display:grid;place-items:center;border-radius:18px;background:linear-gradient(145deg,#91efbb,#42b978);color:#10251a;font-size:31px;font-weight:700;box-shadow:0 10px 28px rgba(65,190,123,.24)}
    h1{margin:0;font-size:25px;letter-spacing:-.03em;font-weight:650}p{margin:13px 0 0;color:rgba(244,247,245,.58);font-size:14px;line-height:1.7}.status{margin-top:27px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.055);color:${tone};font-size:12px}.back{display:inline-block;margin-top:27px;color:#78e0a7;font-size:13px;text-decoration:none}.back:hover{text-decoration:underline}.foot{margin-top:25px;color:rgba(244,247,245,.3);font-size:11px}
    @media(prefers-reduced-motion:no-preference){.card{animation:rise .45s cubic-bezier(.2,.8,.2,1)}.mark{animation:pop .55s .12s both cubic-bezier(.2,.9,.2,1)}@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes pop{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}}
  </style></head><body><div class="orb" aria-hidden="true"></div><main class="card"><div class="mark" aria-hidden="true">${icon}</div><h1>${heading}</h1><p>${detail}</p><div class="status">${success ? '账户已安全连接 · 可以关闭浏览器窗口' : '没有任何账户信息被发送到此页面'}</div><a class="back" href="https://nextco.work/">返回 NextCoWork</a><div class="foot">NextCoWork · 你的工作空间</div></main><script>setTimeout(()=>{if(window.opener)window.close()},1200)</script></body></html>`
}

function announce(next: ClientAuthState): ClientAuthState {
  windows.emitToAll('clientAuth:changed', next)
  return next
}

function ensureRefreshTimer(): void {
  if (refreshTimer !== null) return
  refreshTimer = setInterval(() => { void refreshAccessToken() }, 5 * 60_000)
  refreshTimer.unref()
}

function meta(): Meta | null {
  try {
    const value = store.getKv<Meta | null>(META_KEY, null)
    return value && (value.mode === 'offline' || value.mode === 'authenticated') ? value : null
  } catch { return null }
}

function state(): ClientAuthState {
  const m = meta()
  return m === null ? { mode: 'undecided', user: null, expiresAt: null } : m
}

async function saveTokens(access: string, refresh: string, m: Meta): Promise<void> {
  await getHost().secrets.set(ACCESS_REF, access)
  await getHost().secrets.set(REFRESH_REF, refresh)
  store.setKv(META_KEY, m)
  ensureClientProvider()
  void syncClientModels(access)
  ensureRefreshTimer()
  announce(m)
}

async function refreshAccessToken(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
  const refresh = await getHost().secrets.get(REFRESH_REF)
  const m = meta()
    if (!refresh || !m || m.mode !== 'authenticated') return
    if (m.expiresAt !== null && m.expiresAt - Date.now() > 2 * 60_000) return
    const response = await getHost().fetch(`${API_ROOT}/api/client/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refresh }) }).catch(() => null)
    if (!response?.ok) return
    const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in || meta()?.mode !== 'authenticated') return
    await getHost().secrets.set(ACCESS_REF, tokens.access_token)
    await getHost().secrets.set(REFRESH_REF, tokens.refresh_token)
    const next = { ...m, expiresAt: Date.now() + tokens.expires_in * 1000 }
    store.setKv(META_KEY, next)
    announce(next)
  })().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

/**
 * 保证这条供应商记录在，且**身份字段**是平台那份。
 *
 * ★★ **只钉身份,不钉配置。** 名称 / 地址 / 凭证引用归登录流程(access token 是发往
 * 平台域名的凭证,地址一旦被改走就等于把它送到别处去);而 `protocol` /
 * `protocolOptions` / `priority` / `enabled` 是**用户在设置页改的**,这里必须原样留着 ——
 * 以前整条重写,表现是用户翻完「API 格式」开关,下一次读登录态就被静默改回 openai-chat。
 */
function ensureClientProvider(): void {
  const identity = {
    id: CLIENT_PROVIDER_ID,
    name: 'NextCoWork',
    baseUrl: `${API_ROOT}/v1`,
    credentialRef: ACCESS_REF
  } as const
  const current = store.listProviders().find((p) => p.id === CLIENT_PROVIDER_ID)
  if (current === undefined) {
    store.putProvider({ ...identity, protocol: 'openai-chat', priority: 1, enabled: true })
    return
  }
  if (
    current.name !== identity.name ||
    current.baseUrl !== identity.baseUrl ||
    current.credentialRef !== identity.credentialRef
  ) {
    store.putProvider({ ...current, ...identity })
  }
}

/**
 * 首次登录时把平台的模型列表灌进去。
 *
 * ★★ **已经有别名就一步都不做** —— 这张表在设置页是可编辑的(增删、改名、排序),
 * 而这个函数每次读登录态都会跑。不早退的话它就是一次**整表覆盖**:用户删掉的模型
 * 下次启动自己回来,改过的顺序被重排。自动同步因此只服务冷启动,之后靠设置页
 * 那颗「从服务商拉取模型列表」按钮刷新(它走 `provider:fetchModels` + `provider:setAliases`,
 * 是替换语义、可勾选)。
 *
 * 代价:平台以后新增的模型不会再自动出现在老用户的列表里。这是「删掉的不许自己回来」
 * 的必然对价 —— 两者不可能同时成立,而后者是用户明确要的。
 */
async function syncClientModels(access: string): Promise<void> {
  if (store.listAliases().some((a) => a.providerId === CLIENT_PROVIDER_ID)) return
  try {
    const response = await getHost().fetch(`${API_ROOT}/v1/models`, { headers: { Authorization: `Bearer ${access}` } })
    if (!response.ok) return
    if (meta()?.mode !== 'authenticated') return
    const body = await response.json() as { data?: Array<{ id: string; display_name?: string; displayName?: string; context_window?: number; max_output_tokens?: number; capabilities?: string[] }> }
    const remote = body.data ?? []
    remote.forEach((m, index) => {
      const caps = new Set((m.capabilities ?? []).map((x) => x.toLowerCase()))
      store.putAlias({ alias: m.id, providerId: CLIENT_PROVIDER_ID, upstreamModel: m.id, priority: index * 10,
        displayName: m.display_name ?? m.displayName,
        capabilities: { tools: caps.has('tools'), vision: caps.has('vision') || caps.has('imageinput'), thinking: caps.has('thinking'), caching: caps.has('caching') },
        contextWindow: Number.isFinite(m.context_window) && (m.context_window ?? 0) > 0 ? m.context_window! : 128_000,
        maxOutputTokens: Number.isFinite(m.max_output_tokens) && (m.max_output_tokens ?? 0) > 0 ? m.max_output_tokens! : 16_000, enabled: true })
    })
    windows.emitToAll('provider:changed', { providers: store.listProviders(), models: store.listAliases() })
  } catch { /* model sync is best effort; user can retry from the model page */ }
}

async function fetchMe(access: string): Promise<ClientAuthUser> {
  const response = await getHost().fetch(`${API_ROOT}/api/client/account`, { headers: { Authorization: `Bearer ${access}` } })
  if (!response.ok) throw new Error(`account request failed: ${response.status}`)
  const body = await response.json() as { data?: { user?: ClientAuthUser; wallet?: ClientAuthUser['wallet'] }; user?: ClientAuthUser; wallet?: ClientAuthUser['wallet'] }
  const payload = body.data ?? body
  const user = payload.user
  if (!user) throw new Error('account response invalid')
  return { ...user, wallet: payload.wallet ?? user.wallet }
}

export function getClientAuthState(): ClientAuthState {
  const current = state()
  if (current.mode === 'authenticated') {
    ensureClientProvider(); ensureRefreshTimer()
    void getHost().secrets.get(ACCESS_REF).then((access) => { if (access && meta()?.mode === 'authenticated') void syncClientModels(access) }).catch(() => undefined)
  }
  else {
    for (const alias of store.listAliases().filter((a) => a.providerId === CLIENT_PROVIDER_ID)) store.removeAlias(CLIENT_PROVIDER_ID, alias.alias)
    if (store.listProviders().some((p) => p.id === CLIENT_PROVIDER_ID)) store.removeProvider(CLIENT_PROVIDER_ID)
  }
  return current
}

export async function useOffline(): Promise<ClientAuthState> {
  const next: Meta = { mode: 'offline', user: null, expiresAt: null }
  store.setKv(META_KEY, next)
  return announce(next)
}

export async function signOutClient(): Promise<ClientAuthState> {
  const refresh = await getHost().secrets.get(REFRESH_REF)
  if (refresh) {
    await getHost().fetch(`${API_ROOT}/api/client/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT_ID, refresh_token: refresh }) }).catch(() => undefined)
  }
  const remove = getHost().secrets.remove
  if (remove) {
    await remove(ACCESS_REF)
    await remove(REFRESH_REF)
  }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  store.setKv(META_KEY, null)
  for (const alias of store.listAliases().filter((a) => a.providerId === CLIENT_PROVIDER_ID)) store.removeAlias(CLIENT_PROVIDER_ID, alias.alias)
  store.removeProvider(CLIENT_PROVIDER_ID)
  return announce(state())
}

export async function startClientLogin(): Promise<ClientAuthState> {
  if (callbackServer) throw new Error('已有登录流程正在进行')
  const stateToken = randomBytes(24).toString('hex')
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  let redirectUri = ''
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      callbackServer?.close()
      callbackServer = null
      reject(new Error('登录等待超时'))
    }, 10 * 60_000)
    const fail = (error: unknown) => {
      clearTimeout(timeout)
      callbackServer?.close()
      callbackServer = null
      reject(error)
    }
    callbackServer = createServer((req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }
      if (url.searchParams.get('state') !== stateToken) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(callbackPage(false)); return }
      const authCode = url.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(callbackPage(Boolean(authCode)))
      callbackServer?.close(); callbackServer = null
      clearTimeout(timeout)
      if (!authCode) reject(new Error(url.searchParams.get('error') ?? '登录被取消'))
      else resolve(authCode)
    })
    callbackServer.on('error', fail)
    callbackServer.listen(0, '127.0.0.1', () => {
      const address = callbackServer?.address()
      if (!address || typeof address === 'string') { fail(new Error('无法创建本地回调')); return }
      const redirect = `http://127.0.0.1:${address.port}/callback`
      redirectUri = redirect
      const authorize = new URL(`${API_ROOT}/client/authorize`)
      authorize.searchParams.set('client_id', CLIENT_ID)
      authorize.searchParams.set('redirect_uri', redirect)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('state', stateToken)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('code_challenge_method', 'S256')
      authorize.searchParams.set('scope', 'profile:read wallet:read usage:read models:read inference:write')
      void shell.openExternal(authorize.toString()).catch(fail)
    })
  })
  const response = await getHost().fetch(`${API_ROOT}/api/client/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: verifier })
  })
  if (!response.ok) throw new Error(`登录失败：${response.status}`)
  const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number; user?: ClientAuthUser }
  const user = tokens.user ?? await fetchMe(tokens.access_token)
  const next: Meta = { mode: 'authenticated', user, expiresAt: Date.now() + tokens.expires_in * 1000 }
  await saveTokens(tokens.access_token, tokens.refresh_token, next)
  return announce(next)
}

export async function getClientUser(): Promise<ClientAuthUser | null> {
  await refreshAccessToken()
  const access = await getHost().secrets.get(ACCESS_REF)
  if (!access) return null
  try { const user = await fetchMe(access); const m = meta(); if (m) store.setKv(META_KEY, { ...m, user }); return user } catch { return meta()?.user ?? null }
}

export async function getClientUsage(req: { from?: string; to?: string }): Promise<ClientUsageEntry[]> {
  await refreshAccessToken()
  const access = await getHost().secrets.get(ACCESS_REF)
  if (!access) return []
  const url = new URL(`${API_ROOT}/api/client/usage`)
  if (req.from) url.searchParams.set('from', req.from)
  if (req.to) url.searchParams.set('to', req.to)
  const response = await getHost().fetch(url, { headers: { Authorization: `Bearer ${access}` } })
  if (!response.ok) return []
  const body = await response.json() as { data?: { items?: ClientUsageEntry[] }; items?: ClientUsageEntry[] }
  return body.data?.items ?? body.items ?? []
}
