import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { collectArtifacts, uploadArtifacts } from './upload-client-release.mjs'

test('collectArtifacts finds one uploadable artifact for each target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nextcowork-release-'))
  await Promise.all(['NextCoWork-0.1.3-setup.exe', 'NextCoWork-0.1.3.AppImage', 'NextCoWork-0.1.3-arm64.dmg', 'NextCoWork-0.1.3-x64.dmg'].map(name => writeFile(join(dir, name), name)))
  const result = await collectArtifacts(dir, true)
  assert.equal(result.found.length, 4)
  assert.deepEqual(result.found.map(item => `${item.platform}/${item.architecture}`), ['windows/x64', 'linux/x64', 'macos/arm64', 'macos/x64'])
})

test('collectArtifacts reports missing targets and can be used for partial local uploads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nextcowork-release-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'NextCoWork-0.1.3.AppImage'), 'linux')
  const result = await collectArtifacts(dir)
  assert.equal(result.found.length, 1)
  assert.equal(result.missing.length, 3)
  await assert.rejects(() => collectArtifacts(dir, true), /Missing release artifacts/)
})

test('uploadArtifacts streams the file and sends the API contract headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nextcowork-release-'))
  const fileName = 'NextCoWork-0.1.3.AppImage'
  const content = 'test release bytes'
  await writeFile(join(dir, fileName), content)
  const seen = await new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        resolve({ headers: request.headers, body: Buffer.concat(chunks).toString() })
        response.writeHead(201).end('{}')
        server.close()
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('server did not bind'))
      uploadArtifacts({ dir, version: '0.1.3', baseUrl: `http://127.0.0.1:${address.port}`, channel: 'stable', notes: '', prerelease: false, requireAll: false, dryRun: false }, 'secret').catch(reject)
    })
  })
  assert.equal(seen.body, content)
  assert.equal(seen.headers['x-client-upload-token'], 'secret')
  assert.equal(seen.headers['x-client-platform'], 'linux')
  assert.equal(seen.headers['x-client-sha256'], 'ddf75a50858b2bf67cc6dd88574d2f87ef74ca6ca7cb2428629a78c0eac0a80e')
})
