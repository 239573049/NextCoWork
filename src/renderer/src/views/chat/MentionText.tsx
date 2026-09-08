/**
 * 一段可能夹着文件引用的文本 —— 转录气泡里的那一份渲染。
 *
 * ★ **与输入框共用 `parseMentions`**。输入框里画一遍、气泡里再画一遍,
 * 两处各写一个正则的后果是:输入框里是 chip、发出去变成一串方括号,
 * 而用户会以为自己发错了。
 *
 * 与 `MessageFileRef` 的分工:那个是**独立成块**的引用(拖进托盘的文件,
 * 它在 parts 里就是一条 `file_ref`,不属于任何一句话);这个是**行内**的,
 * 它本来就是用户那句话的一部分,位置有意义 ——「先看 A 再改 B」里
 * A 和 B 的先后不能丢。
 */
import { FileText } from 'lucide-react'
import type { ReactNode } from 'react'
import { parseMentions } from '../../../../shared/domain/file-mention'
import { cn } from '../../lib/cn'
import { MENTION_CHIP_CLASS } from './rich-draft'

export function MentionText({ text }: { text: string }): ReactNode {
  const segments = parseMentions(text)
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.raw}</span>
        ) : (
          <MentionChip key={i} name={s.name} path={s.path} />
        )
      )}
    </>
  )
}

/**
 * 行内 chip。★ `align-baseline` + 不设 `line-height`:它必须坐在文字的基线上,
 * 否则一句话里插两个 chip 会把行高顶开,整段的行距跟着变。
 *
 * ★ 显示的是 `name`,完整路径进 `title` —— 与 `MessageFileRef` 同一条理由:
 * 一条长路径糊进气泡文本会撑出横向滚动条。
 */
function MentionChip({ name, path }: { name: string; path: string }): ReactNode {
  return (
    <span
      data-testid="mention-chip"
      title={path}
      className={cn(MENTION_CHIP_CLASS, 'mx-[1px]')}
    >
      <FileText size={11} className="shrink-0 translate-y-[1.5px] text-fg-faint" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
}
