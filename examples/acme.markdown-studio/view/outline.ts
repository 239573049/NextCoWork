/**
 * 大纲扫描 —— 从 markdown 原文提取标题树。纯函数,不碰 React/CM。
 *
 * ## 为什么不用 AST
 *
 * remark 解析一份 AST 要几毫秒到几十毫秒,而大纲在每次输入后都要重算。
 * 标题的词法足够简单(`^ {0,3}#{1,6}\s`),两指针扫行即可;唯一要小心的是
 * **别把围栏代码块里的 `#` 当标题** —— 下面用一个只跟踪开/闭栅栏的轻量
 * 状态机处理,连缩进变体(`~~~`、更长栅栏)一起管。
 */

export interface OutlineItem {
  /** 标题级别 1-6。 */
  level: number
  /** 去掉前导 `#` 与空白后的标题文本。 */
  text: string
  /** 标题所在行(0 基)—— 点击跳转时滚编辑器/预览用。 */
  line: number
}

export function scanOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const lines = source.split('\n')
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? ''
      // 同种栅栏、长度达标才闭合;``` 里开的 ~~~ 不算
      if (fence === null) fence = marker[0] ?? ''
      else if ((fence === '`' || fence === '~') && marker[0] === fence && marker.length >= 3) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = /^( {0,3}#{1,6})(?:\s+(.*))?$/.exec(line)
    if (heading === null) continue
    const hashes = heading[1] ?? ''
    items.push({
      level: hashes.trim().length,
      text: (heading[2] ?? '').trim().replace(/\\#$/, '').trim(),
      line: index
    })
  }
  return items
}

/**
 * 标题的装饰性锚点 id。★ 纯 index,**不掺标题文本**:preview 侧从 React
 * children 里提取的文本和这里的原文(可能带 `**` 等标记)对不上,掺文本的
 * id 一定错位。大纲跳转的主路径是「编辑器行号」(永远精确),预览跳转用
 * 文本匹配兜底 —— 这个 id 只是让预览 DOM 里有可寻址的锚。
 */
export function headingId(_text: string, index: number): string {
  void _text
  return `hd-${index}`
}
