import type { UpdateErrorCode } from '../../../shared/domain/update'
import type { TranslationKey } from '../i18n'

/**
 * 更新错误码 → 文案 key。
 *
 * ★ **不能靠字符串拼。** `about.updates.error.${code}` 看着天经地义,实际一个都
 * 对不上:错误码是 kebab-case(`invalid-metadata`),文案 key 是 camelCase,而且
 * 有两个根本不同名 —— `checksum-mismatch` 的文案叫 `error.checksum`,
 * `download-failed` 的叫 `error.download`。缺 key 不会崩(`translate` 兜底成
 * 显示 key 本身),所以它的症状是**界面上原样蹦出一串 `about.updates.error.
 * invalid-metadata`** —— 没有报错、没有红字,只有用户看得见。AboutPage 里一度
 * 就是这么写的。
 *
 * `not-packaged` 复用「开发模式不检查更新」那条:它只可能在没打包的构建里出现,
 * 说的是同一件事,没必要再写一条一样意思的文案。
 */
const ERROR_KEY: Record<UpdateErrorCode, TranslationKey> = {
  network: 'about.updates.error.network',
  'invalid-metadata': 'about.updates.error.invalidMetadata',
  'checksum-mismatch': 'about.updates.error.checksum',
  'download-failed': 'about.updates.error.download',
  'install-failed': 'about.updates.error.install',
  'unsupported-platform': 'about.updates.error.unsupportedPlatform',
  'not-packaged': 'about.updates.devDisabled'
}

export function updateErrorKey(code: UpdateErrorCode): TranslationKey {
  return ERROR_KEY[code] ?? 'about.updates.failed'
}
