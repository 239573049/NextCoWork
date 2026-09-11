import { describe, expect, it } from 'vitest'
import { createWorkspacePaths, fromSftpPath, toSftpPath } from '../paths'

describe('environment paths', () => {
  it('uses Windows path semantics even on a POSIX client', async () => {
    const paths = createWorkspacePaths({ realpath: async (path) => path }, 'win32')
    expect(await paths.resolve('C:\\work', 'src/file.ts')).toEqual({ abs: 'C:\\work\\src\\file.ts', outside: false })
    expect(await paths.resolve('C:\\work', 'D:\\other')).toEqual({ abs: 'D:\\other', outside: true })
    expect(paths.display('C:\\work', 'C:\\work\\src\\file.ts')).toBe('src/file.ts')
    await expect(paths.resolve('C:\\work', 'D:relative')).rejects.toThrow('invalid-path')
    for (const path of ['D:', '/folder', '\\folder', '\\\\?\\C:\\work', '\\\\.\\pipe\\name']) {
      await expect(paths.resolve('C:\\work', path)).rejects.toThrow('invalid-path')
      expect(paths.isAbsolute(path)).toBe(false)
    }
    expect(await paths.resolve('\\\\server\\share\\work', 'src/file.ts')).toEqual({ abs: '\\\\server\\share\\work\\src\\file.ts', outside: false })
    expect(toSftpPath('C:\\Users\\user\\work', 'win32')).toBe('/C:/Users/user/work')
    expect(fromSftpPath('/C:/Users/user/work', 'win32')).toBe('C:\\Users\\user\\work')
  })

  it('resolves the existing ancestor before checking an instruction boundary', async () => {
    const paths = createWorkspacePaths({ realpath: async (path) => {
      if (path === '/project/link') return '/outside'
      if (path === '/project/link/new') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return path
    } }, 'linux')
    expect(await paths.resolve('/project', 'link/new')).toEqual({ abs: '/outside/new', outside: true })
    await expect(paths.resolveWithin('/project', 'link/new')).rejects.toThrow()
  })

  it('propagates connection errors instead of treating them as absent paths', async () => {
    const paths = createWorkspacePaths({ realpath: async () => { throw new Error('connection lost') } }, 'linux')
    await expect(paths.resolve('/project', 'src/file')).rejects.toThrow('connection lost')
  })
  it('does not fold distinct canonical directories on case-sensitive volumes', async () => {
    const paths = createWorkspacePaths({ realpath: async (path) => path === '/Project/link' ? '/project/private' : path }, 'darwin')
    await expect(paths.resolveWithin('/Project', 'link')).rejects.toThrow()
    expect((await paths.resolve('/Project', 'src')).outside).toBe(false)
  })
})