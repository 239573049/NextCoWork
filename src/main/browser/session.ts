import { readFile, stat, writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, session, type Cookie, type CookiesSetDetails, type OpenDialogOptions, type WebContents } from 'electron'
import { browserPartition, type BrowserProfile } from '../../shared/domain/browser'

const MAX_COOKIE_FILE_BYTES = 10 * 1024 * 1024
const MAX_COOKIES = 5000

interface CookieArchive {
  schemaVersion: 1
  profileId: string
  exportedAt: number
  cookies: Cookie[]
}

function parentOf(sender: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender)
}

function safeFileName(name: string): string {
  const cleaned = name.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '')
  return `${cleaned || 'browser-profile'}.cookies.json`
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function cookieDetails(value: unknown): CookiesSetDetails | null {
  const item = record(value)
  if (item === null || typeof item.name !== 'string' || typeof item.value !== 'string') return null
  if (item.name.length > 4096 || item.value.length > MAX_COOKIE_FILE_BYTES) return null
  const rawDomain = typeof item.domain === 'string' ? item.domain.trim() : ''
  const host = rawDomain.replace(/^\./, '')
  if (host === '' || !/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.')) return null
  const secure = item.secure === true
  const sameSite =
    item.sameSite === 'unspecified' || item.sameSite === 'no_restriction' || item.sameSite === 'lax' || item.sameSite === 'strict'
      ? item.sameSite
      : undefined
  const expirationDate =
    typeof item.expirationDate === 'number' && Number.isFinite(item.expirationDate) && item.expirationDate > 0
      ? item.expirationDate
      : undefined
  return {
    url: `${secure ? 'https' : 'http'}://${host}${typeof item.path === 'string' && item.path.startsWith('/') ? item.path : '/'}`,
    name: item.name,
    value: item.value,
    ...(rawDomain === '' ? {} : { domain: rawDomain }),
    ...(typeof item.path === 'string' && item.path.startsWith('/') ? { path: item.path } : {}),
    ...(secure ? { secure: true } : {}),
    ...(item.httpOnly === true ? { httpOnly: true } : {}),
    ...(expirationDate === undefined ? {} : { expirationDate }),
    ...(sameSite === undefined ? {} : { sameSite })
  }
}

export async function exportBrowserCookies(
  sender: WebContents,
  workspaceId: string,
  profile: BrowserProfile
): Promise<boolean> {
  const cookies = await session.fromPartition(browserPartition(workspaceId, profile.id)).cookies.get({})
  const options = {
    defaultPath: safeFileName(profile.name),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const parent = parentOf(sender)
  const result = parent === null
    ? await dialog.showSaveDialog(options)
    : await dialog.showSaveDialog(parent, options)
  if (result.canceled || result.filePath === undefined) return false
  const archive: CookieArchive = {
    schemaVersion: 1,
    profileId: profile.id,
    exportedAt: Date.now(),
    cookies
  }
  await writeFile(result.filePath, JSON.stringify(archive, null, 2), { encoding: 'utf8', mode: 0o600 })
  return true
}

export async function importBrowserCookies(
  sender: WebContents,
  workspaceId: string,
  profileId: string
): Promise<number | null> {
  const options: OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }
  const parent = parentOf(sender)
  const result = parent === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(parent, options)
  const filePath = result.filePaths[0]
  if (result.canceled || filePath === undefined) return null
  if ((await stat(filePath)).size > MAX_COOKIE_FILE_BYTES) throw new Error('Cookie 文件超过 10 MB，已拒绝导入')
  const parsed = record(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.cookies)) throw new Error('Cookie 文件格式无效')
  if (parsed.cookies.length > MAX_COOKIES) throw new Error('Cookie 文件包含的记录过多')
  const target = session.fromPartition(browserPartition(workspaceId, profileId)).cookies
  let imported = 0
  for (const value of parsed.cookies) {
    const details = cookieDetails(value)
    if (details === null) continue
    await target.set(details)
    imported++
  }
  return imported
}

export async function clearBrowserProfileState(workspaceId: string, profileId: string): Promise<void> {
  await session.fromPartition(browserPartition(workspaceId, profileId)).clearStorageData()
}
