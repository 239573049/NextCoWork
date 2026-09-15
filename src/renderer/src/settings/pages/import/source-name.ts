/**
 * 来源名文案 —— 按 `ImportSourceKind` 取 key。
 *
 * ★ 存在的理由是**别再就地写三元分支**。原先「哪个来源」这件事在页面里
 * 一处一写(卡片标题写了、计数行写了、弹窗提示忘了写),忘了写的那处会静默
 * 退回 Claude Code —— 于是选了 Codex 扫的也是 Codex 目录,提示却说
 * 「预览来自本机 Claude Code 目录」。
 *
 * ★ 用穷尽 `switch` 而不是查表:加第四个来源时 tsc 会因为缺少返回值报错,
 * 查表只会在运行时给个 undefined。
 */
import type { ImportSourceKind } from '../../../../../shared/domain/import'
import type { TranslationKey } from '../../../i18n'

/** 来源的展示名。 */
export function sourceNameKey(kind: ImportSourceKind): TranslationKey {
  switch (kind) {
    case 'codex':
      return 'import.sourceCodex'
    case 'opencode':
      return 'import.sourceOpencode'
    case 'claude-code':
      return 'import.sourceClaude'
  }
}

/** 「N 个项目 · N 个会话」。措辞按来源可以不同(各家对"项目"的叫法不一样)。 */
export function detectedKey(kind: ImportSourceKind): TranslationKey {
  switch (kind) {
    case 'codex':
      return 'import.detectedCodex'
    case 'opencode':
      return 'import.detectedOpencode'
    case 'claude-code':
      return 'import.detected'
  }
}
