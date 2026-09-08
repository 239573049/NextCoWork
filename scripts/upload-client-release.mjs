#!/usr/bin/env node

/**
 * Upload the desktop artifacts produced by electron-builder to CoWork.Api.
 *
 * The API accepts the artifact as the request body (rather than multipart),
 * so this script streams each file and computes its SHA-256 without loading a
 * potentially multi-gigabyte installer into memory.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const packageJson = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(scriptDir, '..', 'package.json'), 'utf8')))
const DEFAULT_BASE_URL = 'https://nextco.work'

export const ARTIFACTS = [
  { platform: 'windows', architecture: 'x64', extension: '.exe' },
  { platform: 'linux', architecture: 'x64', extension: '.AppImage' },
  { platform: 'macos', architecture: 'arm64', extension: '.dmg', marker: 'arm64', artifactType: 'installer' },
  { platform: 'macos', architecture: 'x64', extension: '.dmg', marker: 'x64', artifactType: 'installer' },
  { platform: 'macos', architecture: 'arm64', extension: '.zip', marker: 'arm64', artifactType: 'update' },
  { platform: 'macos', architecture: 'x64', extension: '.zip', marker: 'x64', artifactType: 'update' }
]

function usage() {
  return `Usage: node scripts/upload-client-release.mjs [options]

Options:
  --dir <directory>       Artifact directory (default: dist)
  --version <version>     Version, with or without a leading v (default: package.json)
  --base-url <url>        API origin (default: https://nextco.work)
  --channel <channel>     Release channel (default: stable, beta for prereleases)
  --notes <text>          Release notes sent to the API
  --prerelease             Mark the release as a prerelease
  --mandatory              Mark the release as a mandatory update
  --minimum-supported-version <version>
  --grace-until <ISO date> Grace period for mandatory updates
  --require-all            Fail when one of the four platform artifacts is absent
  --ignore-duplicates      Treat the API's 409 (already uploaded) as success
  --dry-run               Validate and print uploads without sending them
`
}

export function parseArgs(argv) {
  const options = { dir: 'dist', version: packageJson.version, baseUrl: DEFAULT_BASE_URL, channel: 'stable', notes: '', prerelease: false, mandatory: false, minimumSupportedVersion: '', graceUntil: '', requireAll: false, ignoreDuplicates: false, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true, options }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg === '--require-all') { options.requireAll = true; continue }
    if (arg === '--ignore-duplicates') { options.ignoreDuplicates = true; continue }
    if (arg === '--prerelease') { options.prerelease = true; continue }
    if (arg === '--mandatory') { options.mandatory = true; continue }
    const key = { '--dir': 'dir', '--version': 'version', '--base-url': 'baseUrl', '--channel': 'channel', '--notes': 'notes', '--minimum-supported-version': 'minimumSupportedVersion', '--grace-until': 'graceUntil' }[arg]
    if (!key || i + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${arg}`)
    options[key] = argv[++i]
  }
  options.version = options.version.trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(options.version)) throw new Error(`Invalid SemVer: ${options.version}`)
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(options.channel)) throw new Error(`Invalid channel: ${options.channel}`)
  options.prerelease ||= options.version.includes('-')
  if (options.prerelease && options.channel === 'stable') options.channel = 'beta'
  return { help: false, options }
}

async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => entry.name)
}

export async function collectArtifacts(dir, requireAll = false, version = '') {
  const root = resolve(dir)
  const names = await filesIn(root)
  const found = []
  const missing = []
  for (const spec of ARTIFACTS) {
    const candidates = names.filter(name => name.endsWith(spec.extension) && (!spec.marker || name.includes(spec.marker)) && (!version || name.includes(version)))
    if (candidates.length === 0) { missing.push(`${spec.platform}/${spec.architecture}${spec.extension}`); continue }
    // electron-builder emits one file per target. Sorting makes selection deterministic
    // when a previous build is present in the same directory.
    found.push({ ...spec, path: join(root, candidates.sort().at(-1)), fileName: candidates.sort().at(-1) })
  }
  if (requireAll && missing.length) throw new Error(`Missing release artifacts: ${missing.join(', ')}`)
  return { found, missing }
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function postFile(url, headers, path, size) {
  return new Promise((resolveResponse, reject) => {
    const parsed = new URL(url)
    let responseStarted = false
    const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed, { method: 'POST', headers: { ...headers, 'Content-Length': size } }, response => {
      responseStarted = true
      const chunks = []
      let responseSize = 0
      response.setEncoding('utf8')
      response.on('data', chunk => { if (responseSize < 1024 * 1024) { chunks.push(chunk); responseSize += chunk.length } })
      response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, body: chunks.join('') }))
    })
    // An authenticated API error can close the request while its body is still
    // being streamed. Preserve the HTTP status/body in that case instead of
    // replacing it with a misleading ECONNRESET.
    request.on('error', error => { if (!responseStarted) reject(error) })
    const input = createReadStream(path)
    input.on('error', error => { if (!responseStarted) reject(error) })
    input.pipe(request)
  })
}

export async function uploadArtifacts(options, token) {
  if (!token && !options.dryRun) throw new Error('CLIENT_UPLOAD_TOKEN is required (the token is never printed)')
  const { found, missing } = await collectArtifacts(options.dir, options.requireAll, options.version)
  if (!found.length) throw new Error(`No release artifacts found in ${resolve(options.dir)}`)
  const endpoint = new URL('/api/client/updates/upload', options.baseUrl).toString()
  for (const artifact of found) {
    const info = await stat(artifact.path)
    const hash = await sha256(artifact.path)
    const headers = {
      'X-Client-Upload-Token': token ?? '',
      'X-Client-Version': options.version,
      'X-Client-Platform': artifact.platform,
      'X-Client-Architecture': artifact.architecture,
      'X-Client-Channel': options.channel,
      'X-Client-File-Name': basename(artifact.fileName),
      'X-Client-Sha256': hash,
      'X-Client-Release-Notes': options.notes,
      'X-Client-Prerelease': String(options.prerelease),
      'X-Client-Artifact-Type': artifact.artifactType ?? 'installer',
      'X-Client-Mandatory': String(options.mandatory),
      'X-Client-Minimum-Supported-Version': options.minimumSupportedVersion ?? '',
      'X-Client-Grace-Until': options.graceUntil ?? ''
    }
    if (options.dryRun) {
      console.log(`dry-run: ${artifact.platform}/${artifact.architecture} ${artifact.fileName} (${info.size} bytes, ${hash})`)
      continue
    }
    const response = await postFile(endpoint, headers, artifact.path, info.size)
    if (response.status === 409 && options.ignoreDuplicates) {
      console.log(`already uploaded: ${artifact.platform}/${artifact.architecture} ${artifact.fileName}`)
      continue
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Upload failed for ${artifact.fileName} (HTTP ${response.status}): ${response.body.slice(0, 500)}`)
    console.log(`uploaded: ${artifact.platform}/${artifact.architecture} ${artifact.fileName}`)
  }
  if (missing.length) console.warn(`Skipped missing artifacts: ${missing.join(', ')}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { help, options } = parseArgs(process.argv.slice(2))
    if (help) { console.log(usage()); process.exit(0) }
    await uploadArtifacts(options, process.env.CLIENT_UPLOAD_TOKEN)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
