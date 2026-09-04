/**
 * `resolveAttachmentPath` 的单测 —— 协议的**第二层**安全边界。
 *
 * 第一层(`parseNcwUrl`)由 `shared/__tests__/attachment.test.ts` 穷举;
 * 这里验的是不同的东西:**拼出来的绝对路径落在哪**。
 *
 * 两层不是冗余 —— 第一层管 URL 的形状,第二层管结果的落点。
 * 一个能通过形状校验的 URL 仍可能因为 root 本身的形态(尾斜杠、相对路径、
 * 同前缀的兄弟目录)而拼到根外面去。
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { resolveAttachmentPath } from '../attachment-protocol'

const ROOT = resolve('/tmp/ncw-test/attachments')

describe('resolveAttachmentPath', () => {
  it('会话附件解析到 sessions/<id>/<file>', () => {
    expect(resolveAttachmentPath(ROOT, 'ncw://attachments/sessions/S1/a.png')).toBe(
      resolve(ROOT, 'sessions/S1/a.png')
    )
  })

  it('主题图解析到 themes/<file>', () => {
    expect(resolveAttachmentPath(ROOT, 'ncw://attachments/themes/t.png')).toBe(
      resolve(ROOT, 'themes/t.png')
    )
  })

  it('root 带尾斜杠时结果一致 —— 拼接不能因为调用方的书写习惯而变', () => {
    expect(resolveAttachmentPath(`${ROOT}/`, 'ncw://attachments/themes/t.png')).toBe(
      resolve(ROOT, 'themes/t.png')
    )
  })

  it.each([
    'ncw://attachments/sessions/%2e%2e/%2e%2e/id_rsa',
    'ncw://attachments/sessions/S1/%2e%2e%2f%2e%2e%2f%2e%2e%2fid_rsa',
    'ncw://attachments/../../../etc/passwd',
    'ncw://attachments/sessions/S1/..%5c..%5cwin.ini'
  ])('逃逸尝试 %s 被拒', (url) => {
    expect(resolveAttachmentPath(ROOT, url)).toBeNull()
  })

  it('非法协议/host 被拒', () => {
    expect(resolveAttachmentPath(ROOT, 'file:///etc/passwd')).toBeNull()
    expect(resolveAttachmentPath(ROOT, 'ncw://evil/themes/t.png')).toBeNull()
  })

  it('未知 scope 目录被拒 —— 不能凭 URL 读到附件根下的任意子目录', () => {
    expect(resolveAttachmentPath(ROOT, 'ncw://attachments/secrets/x/a.png')).toBeNull()
  })

  it('★ 同前缀的兄弟目录不算「在根内」', () => {
    // `/tmp/ncw-test/attachments-evil` 与 root 有共同前缀,但它在根外。
    // relative() 会给出 `../attachments-evil/...`,前缀判断若写成
    // `target.startsWith(root)` 就会放行 —— 这条用例钉的就是那个写法。
    const sneaky = resolve('/tmp/ncw-test/attachments-evil')
    expect(resolveAttachmentPath(sneaky, 'ncw://attachments/themes/t.png')).toBe(
      resolve(sneaky, 'themes/t.png')
    )
    // 反过来:用真 root 解析,结果绝不该落进 -evil 目录
    const out = resolveAttachmentPath(ROOT, 'ncw://attachments/themes/t.png') as string
    expect(out.startsWith(`${ROOT}/`)).toBe(true)
    expect(out.includes('attachments-evil')).toBe(false)
  })

  it('畸形输入不崩', () => {
    expect(resolveAttachmentPath(ROOT, '')).toBeNull()
    expect(resolveAttachmentPath(ROOT, 'ncw://attachments/themes/%zz')).toBeNull()
  })
})
