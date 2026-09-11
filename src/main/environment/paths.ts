import { posix, win32 } from 'node:path'
import type { KernelFs, WorkspacePaths } from '../kernel/host'
import { PathEscapeError } from '../kernel/tool/path-guard'
import { EnvironmentError, missingPath } from './errors'

export function createWorkspacePaths(fs: Pick<KernelFs, 'realpath'>, os: string): WorkspacePaths {
  const paths = os === 'win32' ? win32 : posix
  const inside = (root: string, target: string): boolean => {
    const normalized = paths.normalize(root)
    const prefix = normalized.endsWith(paths.sep) ? normalized : `${normalized}${paths.sep}`
    const absolute = paths.normalize(target)
    return absolute === normalized || absolute.startsWith(prefix)
  }
  const validInput = (input: string): boolean => os !== 'win32' || (!/^[a-z]:(?:$|[^\\/])/i.test(input)
    && !/^[\\/](?![\\/])/.test(input) && !/^(?:\\\\|\/\/)[?.][\\/]/.test(input))
  const canonical = async (path: string): Promise<string> => {
    let current = path
    const tail: string[] = []
    for (;;) {
      try { return paths.join(await fs.realpath(current), ...tail) } catch (error) {
        if (!missingPath(error)) throw error
        const parent = paths.dirname(current)
        if (parent === current) throw error
        tail.unshift(paths.basename(current))
        current = parent
      }
    }
  }
  const resolver: WorkspacePaths = {
    style: os === 'win32' ? 'win32' : 'posix',
    join: (...parts) => paths.join(...parts),
    dirname: paths.dirname,
    basename: paths.basename,
    extname: paths.extname,
    isAbsolute: (input) => validInput(input) && paths.isAbsolute(input),
    relative: (root, path) => paths.relative(root, path).split(paths.sep).join('/'),
    async resolve(root, input) {
      if (typeof input !== 'string' || input.includes('\0')) throw new EnvironmentError('invalid-path')
      if (!validInput(input) || !validInput(root)) {
        throw new EnvironmentError('invalid-path')
      }
      if (!paths.isAbsolute(input) && (root === '' || !paths.isAbsolute(root))) throw new EnvironmentError('invalid-path')
      const absolute = await canonical(paths.isAbsolute(input) ? paths.normalize(input) : paths.resolve(root, input))
      if (root === '') return { abs: absolute, outside: true }
      try { return { abs: absolute, outside: !inside(await fs.realpath(root), absolute) } } catch (error) {
        if (paths.isAbsolute(input) && missingPath(error)) return { abs: absolute, outside: true }
        throw error
      }
    },
    async resolveWithin(root, input) {
      const result = await resolver.resolve(root, input)
      if (result.outside) throw new PathEscapeError(input, root)
      return result.abs
    },
    display(root, absolute) {
      if (root === '' || !inside(root, absolute)) return absolute
      return resolver.relative(root, absolute) || '.'
    }
  }
  return resolver
}

export function toSftpPath(path: string, os: string): string {
  if (os !== 'win32') return path
  if (/^[a-z]:[\\/]/i.test(path)) return `/${path.replaceAll('\\', '/')}`
  return path.replaceAll('\\', '/')
}

export function fromSftpPath(path: string, os: string): string {
  if (os !== 'win32') return path
  return win32.normalize(path.replace(/^\/(?=[a-z]:\/)/i, ''))
}