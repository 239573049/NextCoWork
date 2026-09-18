/**
 * `credentials` 表的程序自管加密 —— AES-256-GCM,主密钥是数据库目录下的
 * 一个 0600 权限密钥文件。
 *
 * ## 为什么不再用 safeStorage(方案 §9 的修订)
 *
 * safeStorage 绑定系统密钥环:Linux 无 keyring 的机器上 `isEncryptionAvailable()`
 * 为 false,旧实现**直接拒绝存储密钥**。换成程序自管加密后:
 * - 任何文件系统可写的环境都能存,不再有「配不了密钥」的平台;
 * - 加解密逻辑零依赖 Electron(本文件不 import electron,vitest 里直测);
 * - 主密钥与库同目录,备份/恢复跟随数据库走。
 *
 * 代价(用户已确认接受):拿到磁盘访问权即可解密 —— 保护从「OS 绑定」
 * 降为「文件权限」,换来全平台可用与实现简单。
 *
 * ## blob 格式(自描述,数据库表结构因此一条迁移都不用写)
 *
 * ```
 * "NCK1"(4B magic) + version(1B,现值 1) + nonce(12B) + 密文 + GCM tag(16B)
 * ```
 *
 * ★ 判据是 magic 前缀,不是「解得开解不开」:旧 safeStorage 行是任意字节,
 *   拿去试解只会得到垃圾或异常,分不清「旧格式」和「坏了」。读路径
 *   (`host/index.ts` 的 secrets.get)对无 magic 的行走 safeStorage 兜底 ——
 *   那条兜底是**长期保留**的,不只是迁移期:旧备份随时可能把旧格式行
 *   恢复进一个早已迁完的库。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

const MAGIC = Buffer.from('NCK1', 'utf8')
const FORMAT_VERSION = 1
const NONCE_BYTES = 12
const KEY_BYTES = 32
export const CREDENTIAL_KEY_FILENAME = 'credential.key'
/** ★ 0600:密钥文件只归当前用户。写文件时传 mode 只在**创建**那一刻生效,
 *    所以已存在的文件每次读取都再收紧一次；收紧失败就拒绝使用。 */
const KEY_FILE_MODE = 0o600

export function isProgramEncrypted(blob: Uint8Array): boolean {
  /*
    ★ 长度下界 = magic + version + nonce + tag(密文可以为空串)。
      短于它的 blob 不可能是本格式;只比 magic 不比长度的话,一个恰好以
      "NCK1" 开头的旧 safeStorage 行会在 decryptCredentialValue 里切出
      负长度的密文,报出来是一句 Buffer 越界,没人看得懂。
  */
  if (blob.length < MAGIC.length + 1 + NONCE_BYTES + 16) return false
  return MAGIC.every((byte, i) => blob[i] === byte)
}

export function encryptCredentialValue(key: Buffer, plain: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), nonce, ciphertext, cipher.getAuthTag()])
}

/**
 * ★★ 抛错而不是返回 null:解不开只可能是**主密钥不对**或**密文被改过**,
 *   两种情况都必须让调用方看见,静默当「没有密钥」会把「密钥坏了」
 *   伪装成「用户没配过」—— 那正是 credential.ts 文件头骂过的假故障。
 */
export function decryptCredentialValue(key: Buffer, blob: Uint8Array): string {
  if (!isProgramEncrypted(blob)) throw new Error('凭证密文不是程序加密格式(NCK1)')
  const version = blob[MAGIC.length]
  if (version !== FORMAT_VERSION) {
    throw new Error(`未知的凭证密文版本:${version}`)
  }
  const nonce = Buffer.from(blob.subarray(MAGIC.length + 1, MAGIC.length + 1 + NONCE_BYTES))
  const tag = Buffer.from(blob.subarray(blob.length - 16))
  const ciphertext = Buffer.from(blob.subarray(MAGIC.length + 1 + NONCE_BYTES, blob.length - 16))
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * 读 `<dir>/credential.key`;不存在则生成 32 字节随机密钥并以 0600 落盘。
 *
 * ★★ 已存在但长度不是 32 字节 → **抛错,绝不重新生成**。重新生成等于把
 *   库里所有密文静默判死刑(下次解密全失败,表现为「密钥都没配过」),
 *   而截断的密钥文件还有可能被修回来。抛错至少把「坏了」说出口。
 */
function checkedMasterKey(file: string, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new Error(`主密钥文件损坏(长度 ${key.length},应为 ${KEY_BYTES}):${file}`)
  }
  chmodSync(file, KEY_FILE_MODE)
  return key
}

/** 只读已有主密钥。密文存在却文件丢失时必须抛错,不能生成不匹配的新钥匙。 */
export function loadMasterKey(dir: string): Buffer {
  const file = join(dir, CREDENTIAL_KEY_FILENAME)
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`主密钥路径不是普通文件:${file}`)
  }
  return checkedMasterKey(file, readFileSync(file))
}

export function loadOrCreateMasterKey(dir: string): Buffer {
  const file = join(dir, CREDENTIAL_KEY_FILENAME)
  try {
    return loadMasterKey(dir)
  } catch (e) {
    // 只有「不存在」才走生成;别的读失败(权限等)生成新钥匙只会掩盖问题
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const key = randomBytes(KEY_BYTES)
  try {
    // wx 挡住两次首次写入竞态:后到者必须读取先到者的 key,不能覆盖成第二把。
    const fd = openSync(file, 'wx', KEY_FILE_MODE)
    try {
      writeFileSync(fd, key)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(file, KEY_FILE_MODE)
    return key
  } catch (error) {
    key.fill(0)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadMasterKey(dir)
    try { unlinkSync(file) } catch { /* 可能尚未创建,或删除失败由原错误解释 */ }
    throw error
  }
}

/** 迁移编排的注入面 —— safeStorage / SQLite 都在调用方,这里保持零 Electron 可直测 */
export interface CredentialMigrationDeps {
  list: () => Array<{ ref: string; blob: Uint8Array }>
  put: (ref: string, blob: Uint8Array) => void
  /** 解旧 safeStorage 行。不可用/失败返回 null,**不抛** —— 单行失败不拦整轮 */
  decryptLegacy: (blob: Uint8Array) => string | null
  encrypt: (plain: string) => Uint8Array
}

export interface CredentialMigrationResult {
  /** 旧格式行成功转成 NCK1 的条数 */
  migrated: number
  /** 已经是新格式、无事可做的条数 */
  skipped: number
  /** 解不开而**原样保留**的条数(读路径的 safeStorage 兜底仍然认得它们) */
  failed: number
}

/**
 * 把旧 safeStorage 密文行改写成本程序格式。幂等:转换过的行带 magic,
 * 第二轮全部落入 skipped,零写入 —— 于是每次启动都跑一遍也是安全的,
 * 不需要 kv 表里加「迁过了」的标志位。
 */
export function migrateCredentialRows(deps: CredentialMigrationDeps): CredentialMigrationResult {
  const result: CredentialMigrationResult = { migrated: 0, skipped: 0, failed: 0 }
  for (const row of deps.list()) {
    if (isProgramEncrypted(row.blob)) {
      result.skipped += 1
      continue
    }
    const plain = deps.decryptLegacy(row.blob)
    if (plain === null) {
      result.failed += 1
      continue
    }
    deps.put(row.ref, deps.encrypt(plain))
    result.migrated += 1
  }
  return result
}
