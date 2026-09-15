/**
 * 来源名文案。★ 这里守的是一个真发生过的 bug:选了 Codex、扫的也确实是
 * `~/.codex`,但「选择要导入的内容」弹窗上写着「预览来自本机 Claude Code 目录」
 * —— 因为那句文案把来源名写死在了字符串里,而页面里的来源分支是一处一写、
 * 漏了这一处。
 *
 * 断言用真实的 ZH/EN 词条,不用桩:写死的文案在桩里看不出来,只有过一遍真表
 * 才会发现「三个来源拿到同一句话」。
 */
import { describe, expect, it } from 'vitest'
import type { ImportSourceKind } from '../../../../../../shared/domain/import'
import { messagesFor, type Locale, type TranslationKey } from '../../../../i18n'
import { detectedKey, sourceNameKey } from '../source-name'

const KINDS: readonly ImportSourceKind[] = ['claude-code', 'codex', 'opencode']
const LOCALES: readonly Locale[] = ['zh-CN', 'en-US']

/** 取一条真实词条并渲染,和运行时 `t()` 同一条路径。 */
function render(
  locale: Locale,
  key: TranslationKey,
  params: Record<string, string | number> = {}
): string {
  const value = messagesFor(locale)[key]
  expect(value, `${locale} 缺词条: ${key}`).toBeDefined()
  const rendered = typeof value === 'function' ? value(params) : (value as string)
  return rendered.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
}

describe('来源名', () => {
  it('每个来源都有自己的名字,两种语言都不重名', () => {
    for (const locale of LOCALES) {
      const names = KINDS.map((kind) => render(locale, sourceNameKey(kind)))
      expect(new Set(names).size, `${locale}: ${names.join(' / ')}`).toBe(KINDS.length)
    }
  })

  it('非 Claude Code 的来源,名字里不出现 Claude', () => {
    for (const locale of LOCALES) {
      for (const kind of KINDS.filter((k) => k !== 'claude-code')) {
        expect(render(locale, sourceNameKey(kind))).not.toMatch(/claude/i)
      }
    }
  })

  it('计数行按来源取词条,三个来源互不共用一个 key', () => {
    expect(new Set(KINDS.map((kind) => detectedKey(kind))).size).toBe(KINDS.length)
  })
})

describe('带来源名的文案', () => {
  /*
    ★ 就是回归点:这两句以前把「Claude Code」焊在句子里。现在它们必须**吃掉**
    传进去的来源名 —— 传 Codex 就得出现 Codex,且不准再出现 Claude。
  */
  const PARAMETERIZED: readonly TranslationKey[] = ['import.selectDialogHint', 'import.notFound']

  it('选择弹窗提示与「未检测到」都跟着来源走', () => {
    for (const locale of LOCALES) {
      for (const key of PARAMETERIZED) {
        for (const kind of KINDS) {
          const source = render(locale, sourceNameKey(kind))
          const text = render(locale, key, { source })
          expect(text, `${locale}/${key}/${kind}`).toContain(source)
          if (kind !== 'claude-code') {
            expect(text, `${locale}/${key}/${kind}`).not.toMatch(/claude/i)
          }
        }
      }
    }
  })
})
