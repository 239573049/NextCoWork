/**
 * 草稿 Tab 铸出会话 id 那一刻,**加附件这个动作**的交接台。
 *
 * ★ 为什么需要它:贴图 / 拖拽 / 「添加附件」都要一个**能往 IPC 送的**会话 id,
 *   而草稿要到这一刻才 `bindChatSession` 铸出来。铸 id 会改 `tab.ref.sessionId`
 *   → `views/registry.tsx` 的 key 跟着 `chatKey` 变 → ChatView 整棵子树**立刻被
 *   卸载重挂**。托盘住在 ChatView 的 `useState` 里,于是这一批 chip 连同它们的
 *   上传承诺一起落在一棵已经不存在的树上 —— 症状是「新对话里第一次贴图什么也
 *   不会发生,第二次才正常」。重挂后那次 `listSessionAttachments` 也救不回来:
 *   它发出去的时候上传还没落库,查到空列表,而它只查一次。
 *
 * 办法是把这一次**动作**原样交给重挂后的实例去做:旧实例一个字节也不传,
 * 新实例的 `storeKey` 已经是真 id,同一个动作再走一遍不会再触发绑定。
 * 与 `stores/session.ts` 的 `adoptDraftSession` 是同一件事的两半 —— 那边搬用户
 * 已经打好的字,这边搬他刚下达、还没做完的动作。
 *
 * ★ 同一下重挂里丢掉的**焦点**不在这里补:`Composer` 挂载时本来就要取焦点
 * (见它 `input` 那段注释),重挂出来的那个实例自然把光标带回输入框。
 *
 * ★ 交接项按**新铸的 sessionId** 存放,不是按草稿键:来取它的那个实例已经改名了。
 *
 * 已知代价:绑定之后那个 Tab 立刻被关掉的话,这里会剩一条取不走的记录(连同它
 * 引用的 File)。只在「贴图的同一瞬间关掉对话」这条路径上发生,一个 Tab 至多一条。
 */

/** 交接的是**动作**而不是结果 —— 系统对话框还没开,结果也就还不存在 */
export type AttachIntent =
  | { kind: 'files'; files: File[] }
  | { kind: 'pick' }

const pending = new Map<string, AttachIntent[]>()

/** 交给重挂后的实例。同一次绑定里可能不止一批(连着贴两张图),按顺序排队 */
export function deferAttachIntent(sessionId: string, intent: AttachIntent): void {
  pending.set(sessionId, [...(pending.get(sessionId) ?? []), intent])
}

/**
 * 取走并清空。★ 必须是**取走**而不是读:留着的话,这个会话以后每一次重挂
 * (换 Tab 回来、重开历史)都会把同一批文件再贴一遍。
 */
export function takeAttachIntents(sessionId: string): AttachIntent[] {
  const intents = pending.get(sessionId)
  if (intents === undefined) return []
  pending.delete(sessionId)
  return intents
}
