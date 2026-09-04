/**
 * 「哪些字符要削掉?」—— 只答一次。
 *
 * 工具描述(`tool/naming.ts`)和 Skill 正文(`context-assembler.ts`)是两处
 * **不同来源的不可信文本**,却拼进**同一份系统提示词**。两边对「控制字符」的
 * 定义一旦分叉,就会出现「MCP 那条描述被削干净了,Skill 那条没有」这种
 * 只在特定组合下才出现的洞 —— 而它不会报错,只会让提示词里多出一段看不见的东西。
 *
 * 同 `abort.ts`:两层必须给出同一个答案时,答案就该只有一份。
 */

/**
 * 削掉 C0 控制字符与 DEL,**保留 `\n` 与 `\t`**。
 *
 * 换行和制表符在描述与正文里是有意义的排版,一起削掉会把一段 Markdown
 * 压成一行;而其余不可见字符能干扰上游的分段,也能让日志里看起来
 * 一模一样的两段文本其实不同。
 */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/**
 * 截断到 `max` 个字符,并**留下明确标记**。
 *
 * 静默截断是更糟的:一段被砍掉一半的 Skill 正文读起来仍然通顺,
 * 你只会觉得模型「没按 Skill 说的做」,而不会想到正文根本没进去。
 */
export function clampWithEllipsis(s: string, max: number, marker = '...'): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - marker.length)) + marker
}
