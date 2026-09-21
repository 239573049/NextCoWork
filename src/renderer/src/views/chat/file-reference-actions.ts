/**
 * 转录里那条文件引用被点开时发生的事 —— 带副作用的那一半（纯展示在
 * `MessageFileRef.tsx` 与 `MentionText.tsx`）。
 *
 * 需求：气泡里的 `file_ref`（拖进托盘的文件）和行内 `@` 引用以前只读，点上去毫无反应 ——
 * 而用户看到的是一枚长得像按钮的 chip，那是一次注定失败的承诺。现在点了就在右侧工作台
 * 打开它，**但先确认它还打得开**：引用是发送那一刻的快照，文件后来被删掉、改名是常态，
 * 直接开只会留下一个显示错误的 Tab。
 *
 * 与 `WorkspaceMarkdownProvider` 的分工：Markdown 里的文件链接走宿主注入的
 * `checkFile` + `onOpenFile`（那条路有地方画内联错误）；这里没有内联文案可放，
 * 失败走 toast。两边共用 `workspaceFileOpenFailure`，「打不开」的判定与文案只有一份。
 */
import { translate } from '../../i18n'
import { workspaceFileOpenFailure } from '../../services/workspace-files'
import { useTabsStore } from '../../stores/tabs'
import { toast } from '../../stores/toast'

/**
 * 打开一条文件引用。打不开时不再往下走 —— 调用方不需要知道结果，
 * 失败已经通过 toast 说清楚了（同一条引用连点多次是一条通知，不是铺满屏幕）。
 */
export async function openFileReference(workspaceId: string, path: string): Promise<void> {
  const failure = await workspaceFileOpenFailure(workspaceId, path)
  if (failure !== null) {
    toast.error(translate(failure), `file-reference:${workspaceId}:${path}`)
    return
  }
  // 由已装插件决定用谁打开 —— 与 ChatView 里 Markdown 链接那条路同一个入口
  useTabsStore.getState().openFile(workspaceId, path)
}
