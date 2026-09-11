import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentError } from '../../environment/errors'
import { createWorkspacePaths } from '../../environment/paths'
import { scanCommands } from '../command/load'
import { nodeHost } from '../host'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ncw-command-source-'))
  roots.push(root)
  const globalRoot = join(root, 'commands')
  mkdirSync(globalRoot)
  writeFileSync(join(globalRoot, 'review.md'), 'Client review')
  writeFileSync(join(globalRoot, 'client-only.md'), 'Client instructions')
  const projectRoot = 'C:\\project\\.next-cowork\\commands'
  const client = nodeHost().fs
  const readClient = vi.fn(async (path: string, max?: number) => {
    if (path.startsWith('C:')) throw new Error('Remote path reached client filesystem')
    return client.readFileBytes(path, max)
  })
  const project = {
    ...client,
    exists: async () => true,
    realpath: async (path: string) => path.endsWith('escape.md') ? 'C:\\private\\escape.md' : path,
    readDir: vi.fn(async () => [{ name: 'review.md', isDir: false }, { name: 'escape.md', isDir: false }]),
    readFileBytes: vi.fn(async () => Buffer.from('Server review'))
  }
  return { fs: { ...client, readFileBytes: readClient }, globalRoot, projectRoot, projectFs: project, projectPath: createWorkspacePaths(project, 'win32'), readClient }
}

describe('command source isolation', () => {
  it('uses the server path dialect and project override without reading that path on the client', async () => {
    const input = fixture()
    const result = await scanCommands(input)
    expect(result.commands.find((command) => command.name === 'review')).toMatchObject({ prompt: 'Server review', scope: 'project', source: `${input.projectRoot}\\review.md` })
    expect(result.commands.find((command) => command.name === 'client-only')).toMatchObject({ prompt: 'Client instructions', scope: 'global' })
    expect(input.projectFs.readFileBytes).toHaveBeenCalledExactlyOnceWith(`${input.projectRoot}\\review.md`, 128 * 1024)
    expect(result.commands.some((command) => command.name === 'escape')).toBe(false)
    expect(result.diagnostics).toHaveLength(1)
    expect(input.readClient.mock.calls.every(([path]) => !path.startsWith('C:'))).toBe(true)
  })

  it('does not substitute global commands when the project connection drops', async () => {
    const input = fixture()
    input.projectFs.readDir.mockRejectedValue(new EnvironmentError('disconnected'))
    await expect(scanCommands(input)).rejects.toMatchObject({ code: 'disconnected' })
    expect(input.projectFs.readFileBytes).not.toHaveBeenCalled()
  })
})