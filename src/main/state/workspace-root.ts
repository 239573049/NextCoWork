/**
 * 本地工作区根路径的**规范形式**,以及按根找工作区的唯一入口。
 *
 * ★ 存在的理由:同一个目录在不同来源里长得不一样。Claude Code 的转录里写的是
 * 会话启动时的 `cwd`(原样,可能经过符号链接);Codex 的 `config.toml` 里写的是
 * 用户手敲的路径;目录选择器给的是 `realpathSync.native` 之后的路径。三者字符串
 * 不等,但指的是同一个项目 —— 不归一化就会为一个目录建出两个工作区,树、会话、
 * 技能全部一分为二,而界面上两个都叫同一个名字,用户根本看不出发生了什么。
 *
 * 归一化三件事:符号链接(macOS 上 /tmp → /private/tmp)、大小写(HFS+/APFS
 * 默认大小写不敏感)、末尾分隔符。
 *
 * ★ 比较一律走 {@link sameRoot} / {@link findLocalWorkspaceByRoot},**不要**直接
 * `w.rootPath === path` —— 库里存量的行是旧规则写进去的,只有把两边都归一化才认得出。
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Workspace } from '../../shared/domain/workspace'
import { isLocalEnvironment } from '../../shared/domain/environment'
import { store } from './store'

/** 大小写不敏感的文件系统:比较前要折叠大小写。 */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

/**
 * 规范化一个本地路径。目录不存在时退回 `resolve` —— 拿不到真身总好过抛异常,
 * 项目目录被删掉的来源照样要能预览。
 */
export function canonicalRoot(path: string): string {
  // ★ 相对路径原样退回:`resolve` 会拿**主进程的 cwd** 去补全,凭空造出一个
  //   和来源毫无关系的根 —— 那比匹配不上还糟。
  if (path === '' || !isAbsolute(path)) return path
  const absolute = resolve(path)
  try {
    // ★ 必须是 `.native`:JS 版的 realpath 解符号链接但**不纠正大小写**,
    //   而目录选择器用的正是 `.native`,两边不一致就白归一化了。
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** 比较用的键。存进库的仍是 {@link canonicalRoot} 的原样结果,只有比较时折叠大小写。 */
function rootKey(path: string): string {
  const canonical = canonicalRoot(path)
  return CASE_INSENSITIVE ? canonical.toLowerCase() : canonical
}

/** 两个路径是否指向同一个目录。 */
export function sameRoot(a: string, b: string): boolean {
  if (a === b) return true
  if (a === '' || b === '') return false
  return rootKey(a) === rootKey(b)
}

/** 按根路径找已有的本地工作区;找不到返回 undefined。 */
export function findLocalWorkspaceByRoot(rootPath: string, workspaces = store.listWorkspaces()): Workspace | undefined {
  if (rootPath === '') return undefined
  const local = workspaces.filter((w) => isLocalEnvironment(w.environment))
  const exact = local.find((w) => w.rootPath === rootPath)
  if (exact !== undefined) return exact
  const key = rootKey(rootPath)
  return local.find((w) => rootKey(w.rootPath) === key)
}
