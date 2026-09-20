/**
 * 工作区根路径的纯归一化与比较。
 *
 * 需求：数据库迁移、导入和工作区选择器都必须把符号链接、大小写与末尾分隔符不同的
 * 路径认作同一目录；如果比较逻辑只能通过 store 取得，底层账户归属迁移会形成
 * `config-profile → store → repo → config-profile` 循环，启动时模块会拿到半初始化状态。
 *
 * 本模块刻意不 import store / repo，只提供可复用的纯路径判据；按根查工作区仍留在
 * `workspace-root.ts`，那里才拥有当前作用域的工作区列表。
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** 大小写不敏感的文件系统:比较前要折叠大小写。 */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

/**
 * 规范化一个本地路径。目录不存在时退回 `resolve` —— 拿不到真身总好过抛异常,
 * 项目目录被删掉的来源照样要能预览。
 */
export function canonicalRoot(path: string): string {
  // ★ 相对路径原样退回:`resolve` 会拿**主进程的 cwd** 去补全,凭空造出一个
  // 和来源毫无关系的根 —— 那比匹配不上还糟。
  if (path === '' || !isAbsolute(path)) return path
  const absolute = resolve(path)
  try {
    // ★ 必须是 `.native`:JS 版的 realpath 解符号链接但**不纠正大小写**,
    // 而目录选择器用的正是 `.native`,两边不一致就白归一化了。
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** 比较用的键。存进库的仍是 `canonicalRoot` 的原样结果,只有比较时折叠大小写。 */
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
