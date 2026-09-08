/**
 * 转录里的文件引用 —— `ContentPart` 的 `file_ref`。
 *
 * 与 `MessageImage.tsx` 里的 `ImagePlaceholder` 同一个理由:只显示文件名,
 * 完整路径可能很长,糊进气泡文本会撑出横向滚动条(真实发生过的 bug)。
 * 这里只读,没有删除/重试 —— 那两个动作属于草稿态的 `AttachmentChip`。
 */
import { FileText } from "lucide-react";
import type { ReactNode } from "react";

export function MessageFileRef({
  name,
  path,
}: {
  name: string;
  path: string;
}): ReactNode {
  return (
    <div
      data-testid="message-file-ref"
      title={path}
      className="flex h-8 max-w-full items-center gap-1.5 rounded-[7px] border border-border bg-tint px-2 text-[11.5px] text-fg-muted"
    >
      <FileText size={13} className="shrink-0 text-fg-faint" />
      <span className="min-w-0 truncate">{name}</span>
    </div>
  );
}
