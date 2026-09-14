/**
 * Agent 浏览器工具组。
 *
 * 这些工具操作的是工作区级浏览器会话，而不是直接把 Electron 的
 * webContents 暴露给模型。页面内容读取仍走受控的 Host fetch，并复用
 * SSRF 检查；UI 标签由 browser:changed 事件同步到对应工作区。
 */
import { z } from 'zod'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { browserPartition } from '../../../../shared/domain/browser'
import { browserManager } from '../../../browser/manager'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'
import { resolvedAddressRisk, ssrfRisk } from './ssrf'
import { WEB_LIMITS } from './web'

const MAX_SNAPSHOT_CHARS = 80_000
const MAX_SNAPSHOT_BYTES = 1_000_000
const MAX_REDIRECTS = 5
/**
 * 取页的墙钟上限。
 *
 * ★ 直接借 `WebFetch` 的那一个,不另起一个数 —— 两个工具做的是同一件事
 * (跟着重定向去读一个公网页面),用户没有理由在这里遇到另一套忍耐度;
 * 更实际的是:同一件事两个常量,调的人只会记得改一个。
 *
 * 之前这条链路**一个超时都没有**:`host.fetch` / `host.browserFetch` 和
 * `readPageText` 的 `reader.read()` 循环都只收了 signal。一个连上了却不发
 * 响应体的服务器,能把整个 run 永久挂住 —— 而隔壁 `web.ts` 一直是有闸的。
 */
const FETCH_TIMEOUT_MS = WEB_LIMITS.FETCH_TIMEOUT_MS

function workspaceIdOf(ctx: { workspaceId?: string; workspaceRoot: string }): string {
  // 生产运行一定带 workspaceId；空值只为无头工具测试提供稳定的拒绝信息。
  return ctx.workspaceId ?? ctx.workspaceRoot
}

function pageText(input: string, maxChars: number): string {
  return input
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
    .slice(0, maxChars)
}

async function readPageText(response: Response, maxChars: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Browser page is larger than ${String(MAX_SNAPSHOT_BYTES)} bytes.`)
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let received = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      received += next.value.byteLength
      if (received > MAX_SNAPSHOT_BYTES) {
        await reader.cancel()
        throw new Error(`Browser page is larger than ${String(MAX_SNAPSHOT_BYTES)} bytes.`)
      }
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } finally {
    reader.releaseLock()
  }
  return pageText(chunks.join(''), maxChars)
}

async function fetchPublicPage(
  url: URL,
  partition: string,
  ctx: {
    host: {
      fetch: typeof fetch
      browserFetch?: (partition: string, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    }
    signal: AbortSignal
  }
): Promise<{ response: Response; url: URL }> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const risk = ssrfRisk(current)
    if (risk !== null) throw new Error(risk)
    const dnsRisk = await resolvedAddressRisk(current.hostname)
    if (dnsRisk !== null) throw new Error(dnsRisk)
    const response = ctx.host.browserFetch === undefined
      ? await ctx.host.fetch(current.href, { signal: ctx.signal, redirect: 'manual' })
      : await ctx.host.browserFetch(partition, current.href, {
          signal: ctx.signal,
          redirect: 'manual',
          credentials: 'include'
        })
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current }
    const location = response.headers.get('location')
    if (location === null) throw new Error('浏览器页面返回了无效的重定向')
    await response.body?.cancel().catch(() => undefined)
    current = new URL(location, current)
  }
  throw new Error(`页面重定向超过 ${String(MAX_REDIRECTS)} 次`)
}

const BrowserOpenInput = z.object({
  url: z.string().url().describe('A complete public http or https URL'),
  title: z.string().max(160).optional().describe('Optional label for the browser tab'),
  profileId: z.string().optional().describe('Optional browser Profile id; defaults to the built-in browser')
})

const browserOpenTool: ToolRegistration = defineTool({
  internalId: 'browser_open',
  description:
    'Open a public web page in the current workspace browser. The tab is isolated to this workspace and this Agent run. ' +
    'Use browser_snapshot to read the page after opening it.',
  schema: BrowserOpenInput,
  readOnly: true,
  destructive: false,
  needsNetwork: true,
  async run(input, ctx) {
    const url = new URL(input.url)
    const risk = ssrfRisk(url)
    if (risk !== null) return toolFail(risk)
    const dnsRisk = await resolvedAddressRisk(url.hostname)
    if (dnsRisk !== null) return toolFail(dnsRisk)
    try {
      const tab = browserManager.open({
        workspaceId: workspaceIdOf(ctx),
        ownerRunId: ctx.runId,
        source: 'agent',
        url: url.href,
        title: input.title,
        profileId: input.profileId,
        openRightPanel: true
      })
      return toolOk(`Opened browser tab ${tab.id} at ${tab.url}. Use browser_snapshot with tabId "${tab.id}" to inspect it.`)
    } catch (err) {
      return toolFail(err instanceof Error ? err.message : String(err))
    }
  }
})

const BrowserNavigateInput = z.object({
  tabId: z.string().min(1),
  url: z.string().url()
})

const browserNavigateTool: ToolRegistration = defineTool({
  internalId: 'browser_navigate',
  description: 'Navigate one of your workspace browser tabs to a public http or https URL.',
  schema: BrowserNavigateInput,
  readOnly: true,
  destructive: false,
  needsNetwork: true,
  async run(input, ctx) {
    const existing = browserManager.get(input.tabId)
    if (existing === undefined) return toolFail(`Browser tab does not exist: ${input.tabId}`)
    if (existing.workspaceId !== workspaceIdOf(ctx)) return toolFail('That browser tab belongs to another workspace.')
    if (existing.source !== 'agent' || existing.ownerRunId !== ctx.runId) {
      return toolFail('You can only navigate a browser tab opened by this Agent run.')
    }
    const url = new URL(input.url)
    const risk = ssrfRisk(url)
    if (risk !== null) return toolFail(risk)
    const dnsRisk = await resolvedAddressRisk(url.hostname)
    if (dnsRisk !== null) return toolFail(dnsRisk)
    try {
      const tab = browserManager.navigate(input.tabId, url.href, {
        workspaceId: workspaceIdOf(ctx),
        runId: ctx.runId
      })
      return toolOk(`Browser tab ${tab.id} is navigating to ${tab.url}.`)
    } catch (err) {
      return toolFail(err instanceof Error ? err.message : String(err))
    }
  }
})

const BrowserSnapshotInput = z.object({
  tabId: z.string().min(1),
  maxChars: z.number().int().min(1000).max(MAX_SNAPSHOT_CHARS).optional()
})

const browserSnapshotTool: ToolRegistration = defineTool({
  internalId: 'browser_snapshot',
  description:
    'Read the current page in one of your workspace browser tabs as cleaned text. This returns page content, not a summary; inspect and cite it yourself.',
  schema: BrowserSnapshotInput,
  readOnly: true,
  destructive: false,
  needsNetwork: true,
  async run(input, ctx) {
    const tab = browserManager.get(input.tabId)
    if (tab === undefined) return toolFail(`Browser tab does not exist: ${input.tabId}`)
    if (tab.workspaceId !== workspaceIdOf(ctx)) return toolFail('That browser tab belongs to another workspace.')
    if (tab.source !== 'agent' || tab.ownerRunId !== ctx.runId) return toolFail('You can only inspect a browser tab opened by this Agent run.')
    const url = new URL(tab.url)
    const risk = ssrfRisk(url)
    if (risk !== null) return toolFail(risk)

    /*
      ★★ 整段取页共用一个闸 —— 抄的是 `web.ts:190-197` 那段,连形状都一样。

      为什么闸要罩住 `readPageText` 而不只是那次 fetch:响应头先回来、响应体
      再也不来,是卡死最常见的形状。而 `reader.read()` 本身不收 signal ——
      能打断它的唯一办法,是 abort **那次 fetch 的 signal**(流会随之 error)。
      所以这里传下去的是 `timer.signal`,不是 `ctx.signal`。
    */
    const timer = new AbortController()
    const onAbort = (): void => {
      timer.abort()
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const t = setTimeout(() => {
      timer.abort()
    }, FETCH_TIMEOUT_MS)

    try {
      const fetched = await fetchPublicPage(
        url,
        browserPartition(tab.workspaceId, tab.profileId),
        { host: ctx.host, signal: timer.signal }
      )
      const response = fetched.response
      if (!response.ok) return toolFail(`Browser page returned HTTP ${String(response.status)}.`)
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (!contentType.startsWith('text/') && !contentType.includes('json') && !contentType.includes('xml')) {
        return toolFail(`This browser tool only reads text pages; received ${contentType || 'unknown content'}.`)
      }
      const text = await readPageText(response, input.maxChars ?? MAX_SNAPSHOT_CHARS)
      browserManager.update(
        tab.id,
        { url: fetched.url.href, status: 'ready' },
        { workspaceId: workspaceIdOf(ctx), runId: ctx.runId }
      )
      return toolOk(`Page: ${tab.title}\nURL: ${fetched.url.href}\n\n${text || '(The page has no readable text.)'}`)
    } catch (err) {
      try {
        browserManager.update(tab.id, { status: 'error' }, { workspaceId: workspaceIdOf(ctx), runId: ctx.runId })
      } catch {
        // The user may close the tab while a background snapshot is in flight.
      }
      // ★ 中断原样抛出,由 `defineTool` 收 —— 伪装成工具失败的话模型会接着往下跑
      if (ctx.signal.aborted) throw err
      if (timer.signal.aborted) {
        return toolFail(
          `Reading ${url.toString()} timed out after ${String(FETCH_TIMEOUT_MS / 1000)} seconds.`
        )
      }
      return toolFail(`Unable to read browser page: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(t)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }
})

const BrowserTabsInput = z.object({})

const browserTabsTool: ToolRegistration = defineTool({
  internalId: 'browser_tabs',
  description: 'List browser tabs available in the current workspace. Agent-owned tabs are visible only to their owner run.',
  schema: BrowserTabsInput,
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(_input, ctx) {
    const tabs = browserManager.list(workspaceIdOf(ctx)).filter((tab) => tab.source === 'agent' && tab.ownerRunId === ctx.runId)
    if (tabs.length === 0) return toolOk('No browser tabs are open in this workspace.')
    return toolOk(tabs.map((tab) => `${tab.id}\t${tab.title}\t${tab.url}\t${tab.status}`).join('\n'))
  }
})

const browserProfilesTool: ToolRegistration = defineTool({
  internalId: 'browser_profiles',
  description: 'List browser Profiles available to this workspace. Profiles are global configuration with isolated cookies and login state.',
  schema: BrowserTabsInput,
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run() {
    const profiles = browserManager.listProfiles()
    return toolOk(profiles.map((profile) => {
      const domains = profile.domains.length === 0 ? '*' : profile.domains.join(', ')
      return `${profile.id}\t${profile.name}\t${profile.isDefault ? 'default' : 'custom'}\t${domains}`
    }).join('\n'))
  }
})

const BrowserCloseInput = z.object({ tabId: z.string().min(1) })

const browserCloseTool: ToolRegistration = defineTool({
  internalId: 'browser_close',
  description: 'Close one of your workspace browser tabs.',
  schema: BrowserCloseInput,
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(input, ctx) {
    try {
      browserManager.close(input.tabId, { workspaceId: workspaceIdOf(ctx), runId: ctx.runId })
      return toolOk(`Closed browser tab ${input.tabId}.`)
    } catch (err) {
      return toolFail(err instanceof Error ? err.message : String(err))
    }
  }
})

export const browserTools: readonly ToolRegistration[] = [
  browserOpenTool,
  browserNavigateTool,
  browserSnapshotTool,
  browserTabsTool,
  browserProfilesTool,
  browserCloseTool
]

export { browserOpenTool, browserNavigateTool, browserSnapshotTool, browserTabsTool, browserProfilesTool, browserCloseTool }
