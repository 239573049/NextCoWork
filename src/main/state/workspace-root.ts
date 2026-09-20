/**
 * 本地工作区根路径的**规范形式**,以及按根找工作区的唯一入口。
 * 纯路径归一化 / 比较在 `workspace-root-path.ts`，这里保留需要读取当前作用域工作区的查找。
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
import type { Workspace } from '../../shared/domain/workspace'
import { isLocalEnvironment } from '../../shared/domain/environment'
import { store } from './store'
import { sameRoot } from './workspace-root-path'

export { canonicalRoot, sameRoot } from './workspace-root-path'

/** 按根路径找已有的本地工作区;找不到返回 undefined。 */
export function findLocalWorkspaceByRoot(rootPath: string, workspaces = store.listWorkspaces()): Workspace | undefined {
  if (rootPath === '') return undefined
  const local = workspaces.filter((w) => isLocalEnvironment(w.environment))
  const exact = local.find((w) => w.rootPath === rootPath)
  if (exact !== undefined) return exact
  return local.find((w) => sameRoot(w.rootPath, rootPath))
}
