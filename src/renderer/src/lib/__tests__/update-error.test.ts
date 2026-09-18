import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../i18n'
import { updateErrorKey } from '../update-error'
import type { UpdateErrorCode } from '../../../../shared/domain/update'

/**
 * 这个用例防的是一类**不会报错、只有用户看得见**的 bug。
 *
 * `translate` 在 key 缺失时兜底成「把 key 原样显示出来」—— 这是对的(一条文案缺了
 * 不该把整个渲染层拉崩),但代价是拼错的 key 一路静默到界面上。AboutPage 里那句
 * `` t(`about.updates.error.${code}`) `` 就这样活了很久:更新一失败,红字位置显示的
 * 是 `about.updates.error.invalid-metadata` 这串东西本身。
 *
 * 所以断言不能只比对映射表 —— 得真去两种语言的文案表里查一遍。
 */
const CODES: readonly UpdateErrorCode[] = [
  'network',
  'invalid-metadata',
  'checksum-mismatch',
  'download-failed',
  'install-failed',
  'unsupported-platform',
  'not-packaged'
]

describe('updateErrorKey', () => {
  it.each(CODES)('%s 在中英两套文案里都查得到', (code) => {
    const key = updateErrorKey(code)
    expect(messagesFor('zh-CN')[key], `zh-CN 缺 ${key}`).toBeDefined()
    expect(messagesFor('en-US')[key], `en-US 缺 ${key}`).toBeDefined()
  })
})
