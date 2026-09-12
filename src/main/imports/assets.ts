/**
 * 导入落盘的文件原语 —— staging 写入 + 原子发布。
 *
 * ## 为什么从 `service.ts` 里分出来
 *
 * 那边管的是「哪一项、去哪、算不算冲突」,这边管的是「字节怎么安全地落到磁盘上」。
 * 两件事的失败模式完全不同:上面那层错了是导错东西,这一层错了是**写坏用户
 * 已有的文件**。分开之后,这一层的每个函数都能单独被夹具盯住。
 *
 * ## 数据库事务包不住文件写入
 *
 * 一个 SQLite 事务回滚不会撤销已经 `rename` 出去的文件。所以这里的承诺只有两条,
 * 而且都是**局部**的:
 *
 * 1. **单个目标要么是旧的、要么是新的**,没有写到一半的中间态 —— 靠同卷
 *    `rename` 的原子性。
 * 2. **中途崩溃只会留下本次 job 自己的 staging 目录**,清理时只清自己那一个,
 *    绝不去动用户的文件。
 *
 * 「整批失败自动撤销全部磁盘副作用」是做不到的,也不该假装做得到 ——
 * 所以批次明细里记了提交阶段,崩溃恢复靠它,不靠一次想象中的回滚。
 */
import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import type { ImportDiagnostic } from '../../shared/domain/import'
import { PACKAGE_LIMITS } from '../kernel/skill/install'

/** 内容指纹。目标基线与源指纹都用它,**同一个函数** —— 两份实现会静默分叉。 */
export function fingerprint(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * 目标此刻的指纹。不存在返回 null。
 *
 * ★ 这是「用户改过没有」的唯一判据。用 mtime 判的话,一次 `touch`、一次
 * git checkout、甚至一次 Dropbox 同步都会被当成用户编辑,而真正的编辑
 * 如果发生在同一秒内反而看不出来。
 */
export async function currentFingerprint(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) return await directoryFingerprint(path)
    if (!info.isFile()) return null
    return fingerprint(await readFile(path))
  } catch {
    return null
  }
}

/** 目录的指纹 = 相对路径 + 各文件指纹的有序摘要。 */
async function directoryFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > PACKAGE_LIMITS.MAX_DEPTH) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(dir, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(child, childRel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      hash.update(childRel).update('\0').update(await readFile(child)).update('\0')
    }
  }
  await walk(root, '', 0)
  return hash.digest('hex')
}

/** 本次 job 专属的 staging 目录。★ 建在**目标卷**上,否则 rename 会退化成跨卷拷贝。 */
export function stagingDirFor(targetRoot: string, jobId: string): string {
  return join(targetRoot, `.ncw-import-${jobId}`)
}

/**
 * 只清理本次 job 自己的 staging。★ 不扫描、不按前缀批量删 ——
 * 一个写错的 glob 在用户的 skills 目录里执行一次就够受了。
 */
export async function cleanupStaging(stagingDir: string): Promise<void> {
  try {
    await rm(stagingDir, { recursive: true, force: true })
  } catch {
    // 清不掉就留着。留一个空目录的代价远小于为了删干净而放宽删除范围。
  }
}

/**
 * 写一个文本文件并原子发布。
 *
 * `expectBaseline` 非 undefined 时会在发布前**再核一次**目标指纹:
 * 对不上说明用户在我们扫描之后改过它,此时返回 `conflict`,不写。
 */
export async function publishTextFile(input: {
  targetPath: string
  content: string
  stagingDir: string
  /** null = 目标此刻应当不存在;字符串 = 目标此刻应当是这个指纹。 */
  expectBaseline?: string | null
}): Promise<{ ok: boolean; fingerprint: string; diagnostics: ImportDiagnostic[] }> {
  const digest = fingerprint(input.content)

  if (input.expectBaseline !== undefined) {
    const actual = await currentFingerprint(input.targetPath)
    if (actual !== input.expectBaseline) {
      return { ok: false, fingerprint: digest, diagnostics: [{ code: 'target.locally-modified' }] }
    }
  }

  await mkdir(input.stagingDir, { recursive: true })
  const temp = join(input.stagingDir, `f-${randomBytes(8).toString('hex')}`)
  await writeFile(temp, input.content, 'utf8')
  await mkdir(dirname(input.targetPath), { recursive: true })
  await rename(temp, input.targetPath)
  return { ok: true, fingerprint: digest, diagnostics: [] }
}

/**
 * 复制一个技能包目录并原子发布。
 *
 * ★ 上限直接用 `PACKAGE_LIMITS` —— zip 安装那条路径用的是同一组常量。
 * 这里不重新定义任何数值,理由写在那边的导出注释里。
 *
 * ★ 逃逸软链**整条拒绝**,不是跳过那一个文件:一个包里出现指向 `~/.ssh`
 * 的链接,说明这个包本身不可信,装它的其余部分没有意义。
 */
export async function publishSkillPackage(input: {
  sourceDir: string
  targetDir: string
  stagingDir: string
  expectBaseline?: string | null
}): Promise<{ ok: boolean; fingerprint: string; diagnostics: ImportDiagnostic[] }> {
  if (input.expectBaseline !== undefined) {
    const actual = await currentFingerprint(input.targetDir)
    if (actual !== input.expectBaseline) {
      return { ok: false, fingerprint: '', diagnostics: [{ code: 'target.locally-modified' }] }
    }
  }

  const stageRoot = join(input.stagingDir, `p-${randomBytes(8).toString('hex')}`)
  const realSource = resolve(input.sourceDir)
  let entries = 0
  let bytes = 0

  const copyTree = async (from: string, to: string, depth: number): Promise<ImportDiagnostic | null> => {
    if (depth > PACKAGE_LIMITS.MAX_DEPTH) {
      return { code: 'skill.package-too-large', detail: `depth>${String(PACKAGE_LIMITS.MAX_DEPTH)}` }
    }
    await mkdir(to, { recursive: true })
    const children = await readdir(from, { withFileTypes: true })
    for (const child of children) {
      const childFrom = join(from, child.name)
      const childTo = join(to, child.name)

      if (child.isSymbolicLink()) {
        // 解析之后必须仍在包内。跟随一条指向包外的链接 = 把任意文件拷进技能目录,
        // 而技能目录的内容会被拼进模型上下文。
        let target: string
        try {
          target = await realpath(childFrom)
        } catch {
          continue
        }
        if (target !== realSource && !target.startsWith(realSource + sep)) {
          return { code: 'skill.unsupported-constraint', detail: `symlink:${child.name}` }
        }
        continue // 包内链接也不复制,复制它的目标文件就够了
      }

      entries += 1
      if (entries > PACKAGE_LIMITS.MAX_ENTRIES) {
        return { code: 'skill.package-too-large', detail: `entries>${String(PACKAGE_LIMITS.MAX_ENTRIES)}` }
      }

      if (child.isDirectory()) {
        const failure = await copyTree(childFrom, childTo, depth + 1)
        if (failure !== null) return failure
        continue
      }
      if (!child.isFile()) continue

      const info = await stat(childFrom)
      bytes += info.size
      if (bytes > PACKAGE_LIMITS.MAX_EXPANDED) {
        return { code: 'skill.package-too-large', detail: `bytes>${String(PACKAGE_LIMITS.MAX_EXPANDED)}` }
      }
      await copyFile(childFrom, childTo)
    }
    return null
  }

  const failure = await copyTree(realSource, stageRoot, 0)
  if (failure !== null) {
    await cleanupStaging(stageRoot)
    return { ok: false, fingerprint: '', diagnostics: [failure] }
  }

  const digest = await directoryFingerprint(stageRoot)
  await mkdir(dirname(input.targetDir), { recursive: true })
  // 目标已存在时先挪开再换上 —— `rename` 到一个非空目录在各平台上行为不一致。
  const displaced = await exists(input.targetDir)
    ? join(input.stagingDir, `old-${randomBytes(8).toString('hex')}`)
    : null
  if (displaced !== null) await rename(input.targetDir, displaced)
  await rename(stageRoot, input.targetDir)
  return { ok: true, fingerprint: digest, diagnostics: [] }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 有界读取一个文本文件。超限返回 null —— 报告出来,不截断后冒充完整。 */
export async function readTextBounded(path: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > maxBytes) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
