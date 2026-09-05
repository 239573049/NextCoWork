import { describe, expect, it } from 'vitest'
import { operationRequest, type FileOperationTarget } from '../file-operations'

const target = (operation: FileOperationTarget['operation'], path = 'docs/notes.md'): FileOperationTarget => ({
  operation,
  path,
  name: path.split('/').at(-1) ?? '',
})

describe('file operation paths', () => {
  it('creates in the selected directory, including the workspace root', () => {
    expect(operationRequest('work', target('create-file', ''), 'notes.md')).toEqual({
      request: { workspaceId: 'work', operation: 'create-file', path: 'notes.md' },
    })
    expect(operationRequest('work', target('create-directory', 'docs'), 'drafts')).toEqual({
      request: { workspaceId: 'work', operation: 'create-directory', path: 'docs/drafts' },
    })
  })

  it('renames within the original folder', () => {
    expect(operationRequest('work', target('rename'), 'readme.md')).toEqual({
      request: { workspaceId: 'work', operation: 'rename', path: 'docs/notes.md', destination: 'docs/readme.md' },
    })
    expect(operationRequest('work', target('rename', 'notes.md'), 'readme.md').request?.destination).toBe('readme.md')
  })

  it.each(['copy', 'move'] as const)('treats %s destinations as workspace relative', (operation) => {
    expect(operationRequest('work', target(operation), 'archive/notes.md').request?.destination).toBe('archive/notes.md')
  })

  it.each(['', '.', '..', '../secret', 'docs/new.md', 'docs\\new.md', 'bad\u0000name'])('rejects invalid names: %j', (name) => {
    expect(operationRequest('work', target('rename'), name).error).toBe('files.manage.invalidName')
  })

  it.each(['', '/tmp/test', '../secret', 'docs/../secret', './test', 'docs//test', 'docs/', 'C:/temp/test', 'docs\\test', 'bad\u0000name'])('rejects unsafe destination paths: %j', (path) => {
    expect(operationRequest('work', target('move'), path).error).toBe('files.manage.invalidDestination')
  })

  it.each(['rename', 'move', 'copy'] as const)('rejects an unchanged %s target', (operation) => {
    expect(operationRequest('work', target(operation), operation === 'rename' ? 'notes.md' : 'docs/notes.md').error).toBe('files.manage.unchanged')
  })

  it('keeps file and folder names in the user language', () => {
    expect(operationRequest('work', target('create-file', '方案'), '会议笔记.md').request?.path).toBe('方案/会议笔记.md')
  })

  it('deletion cannot be redirected by a form value', () => {
    expect(operationRequest('work', target('delete'), 'other/path')).toEqual({
      request: { workspaceId: 'work', operation: 'delete', path: 'docs/notes.md' },
    })
  })
})
