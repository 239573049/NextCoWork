/**
 * 文档引擎的**文件侧**:私有工作副本、字节摘要、带冲突检查的原子保存。
 *
 * ## 为了什么需求建的
 *
 * 引擎(原生 helper)绝不能直接写用户工作区里的原文件:
 *
 * - 它是第三方原生代码,写坏一半的文件没有人能恢复;
 * - 用户或 Agent 可能在编辑期间从别处改了同一个文件,直接覆盖就是静默丢数据。
 *
 * 所以引擎只读写**私有工作副本**,保存时由这里校验「盘上的原文件还是我上次读到的
 * 那一份吗」,再用同目录临时文件 + rename 原子替换。和 `ipc/workspace-files.ts` 的
 * 文本 / 图片写入同一套立场,但那条路只收 UTF-8 文本或已分类为 image 的文件,
 * 办公二进制走不了(见计划 §2),所以这里单独一份,不去给那条路开口子。
 *
 * ## 不变式
 *
 * - 首次打开只**复制**,不改原文件的字节与 mtime。
 * - 产物字节和盘上一致时保存是 no-op(不顶 mtime,Agent 不会误读成「刚被改过」)。
 * - 摘要对不上 → `disk_conflict`,**不覆盖**。
 * - 原文件是软链时拒绝:写穿一条链改到的是别处的文件。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DocumentEngineError } from '../../shared/document-engine/protocol'

/**
 * 单个文档的字节上限。★ 与插件 fs 的 8 MiB 不同 —— 办公文档带图片几十 MB 很常见;
 * 但仍然是有限值:引擎要把整份文档装进内存,无上限等于允许一个文件拖垮 helper。
 */
export const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024

export async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => { hash.update(chunk) })
    stream.on('error', reject)
    stream.on('end', () => { resolve() })
  })
  return hash.digest('hex')
}

async function assertRegularFile(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DocumentEngineError('io', 'document does not exist')
    throw new DocumentEngineError('io', `cannot stat document: ${(error as Error).message}`)
  }
  if (info.isSymbolicLink()) throw new DocumentEngineError('io', 'document is a symbolic link')
  if (!info.isFile()) throw new DocumentEngineError('io', 'document is not a regular file')
  if (info.size > MAX_DOCUMENT_BYTES) throw new DocumentEngineError('io', `document exceeds ${MAX_DOCUMENT_BYTES} bytes`)
  return info.size
}

export interface WorkingCopy {
  /** 私有目录里的副本路径,只交给引擎 */
  workingPath: string
  /** 复制那一刻原文件的摘要 */
  diskRevision: string
}

/**
 * 把原文件复制进 `privateDir`,返回副本与摘要。
 *
 * ★ 先摘要、复制、再摘要一次:复制期间原文件被外部写入时,两次摘要不同,
 * 这里判 `disk_conflict` 让调用方重试,而不是把一份「一半旧一半新」的副本交给引擎。
 */
export async function createWorkingCopy(source: string, privateDir: string): Promise<WorkingCopy> {
  await assertRegularFile(source)
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  const before = await digestFile(source)
  const workingPath = join(privateDir, `${randomUUID()}-${basename(source)}`)
  await copyFile(source, workingPath)
  const after = await digestFile(source)
  if (before !== after) {
    await rm(workingPath, { force: true })
    throw new DocumentEngineError('disk_conflict', 'document changed while it was being opened')
  }
  return { workingPath, diskRevision: before }
}

/**
 * 把引擎产物原子替换到原文件。返回新的磁盘摘要。
 *
 * @param expectedDiskRevision 上次读到 / 写入的摘要。盘上不一致时拒绝。
 */
export async function commitSave(target: string, producedPath: string, expectedDiskRevision: string): Promise<string> {
  await assertRegularFile(target)
  const producedSize = (await stat(producedPath)).size
  if (producedSize > MAX_DOCUMENT_BYTES) throw new DocumentEngineError('io', `saved document exceeds ${MAX_DOCUMENT_BYTES} bytes`)
  if (producedSize === 0) {
    // ★ 引擎写出 0 字节几乎一定是导出失败而不是用户清空了文档 —— 替换过去就是把文件抹掉
    throw new DocumentEngineError('io', 'engine produced an empty file')
  }
  if ((await digestFile(target)) !== expectedDiskRevision) {
    throw new DocumentEngineError('disk_conflict', 'document changed on disk since it was opened or last saved')
  }
  const produced = await digestFile(producedPath)
  if (produced === expectedDiskRevision) return produced

  const mode = (await stat(target)).mode & 0o777
  const temporary = join(dirname(target), `.ncw-doc-${randomUUID()}.tmp`)
  let created = false
  try {
    await copyFile(producedPath, temporary)
    created = true
    const handle = await open(temporary, 'r+')
    try {
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    /*
      ★ rename 之前再比一次:从上面那次检查到这里,用户可能又在别的编辑器里存了一次。
      这仍然挡不住「这一行和 rename 之间」的那几微秒 —— 不遵守锁的外部写入者没有
      办法被完全挡住(计划 §5 明确不承诺),但把窗口缩到最小。
    */
    if ((await digestFile(target)) !== expectedDiskRevision) {
      throw new DocumentEngineError('disk_conflict', 'document changed on disk during save')
    }
    await rename(temporary, target)
    created = false
  } finally {
    if (created) await rm(temporary, { force: true })
  }
  return produced
}
