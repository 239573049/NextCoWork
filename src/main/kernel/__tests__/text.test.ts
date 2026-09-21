import { describe, expect, it } from 'vitest'
import { clampWithEllipsis, stripAnsi, stripControlChars } from '../text'

/**
 * 这两个函数各自只有两行,值得单独测的理由在 text.ts 的文件头:
 * 工具描述与 Skill 正文是**两处不同来源的不可信文本**,却拼进**同一份系统提示词**。
 * 定义一旦分叉就会出现只在特定组合下才出现的洞,而它不报错。
 */

describe('stripControlChars', () => {
  it('普通文本原样返回', () => {
    expect(stripControlChars('读取一个文件 read a file')).toBe('读取一个文件 read a file')
  })

  it('空字符串', () => {
    expect(stripControlChars('')).toBe('')
  })

  /** ★ 换行和制表符在描述与正文里是**有意义的排版**,一起削掉会把一段 Markdown 压成一行 */
  it('保留换行与制表符', () => {
    expect(stripControlChars('第一行\n第二行\t带缩进')).toBe('第一行\n第二行\t带缩进')
  })

  it('保留回车', () => {
    // CRLF 来自 Windows 上装的 Skill —— 削掉 \r 会让它和 \n 配不成对
    expect(stripControlChars('a\r\nb')).toBe('a\r\nb')
  })

  it('削掉 NUL', () => {
    expect(stripControlChars('read\u0000_file')).toBe('read_file')
  })

  it('削掉 ESC —— 终端转义序列的开头', () => {
    // 描述会被打进日志;ANSI 序列能改写日志里已经打出来的行
    expect(stripControlChars('\u001B[31m危险\u001B[0m')).toBe('[31m危险[0m')
  })

  it('削掉 BEL、退格、垂直制表、换页', () => {
    expect(stripControlChars('a\u0007b\u0008c\u000Bd\u000Ce')).toBe('abcde')
  })

  it('削掉 DEL', () => {
    expect(stripControlChars('a\u007Fb')).toBe('ab')
  })

  it('削掉整个 C0 区间(除了 \\t \\n \\r)', () => {
    const kept = new Set(['\t', '\n', '\r'])
    for (let i = 0; i <= 0x1f; i++) {
      const ch = String.fromCharCode(i)
      expect(stripControlChars(`a${ch}b`), `U+${i.toString(16).padStart(4, '0')}`).toBe(
        kept.has(ch) ? `a${ch}b` : 'ab'
      )
    }
  })

  /**
   * C1 区间(U+0080–U+009F)不削 —— 它们在 UTF-8 里不是控制字符,
   * 而削掉会破坏合法的西里尔/希腊文本。这条钉的是**边界在哪**。
   */
  it('不碰 C1 区间与其他非 ASCII', () => {
    expect(stripControlChars('°é中🙂')).toBe('°é中🙂')
  })
})

/**
 * `stripAnsi` 钉的是「捕获的是管道、但 CLI 照样着色」这件事:
 * 序列进模型上下文是纯噪声,而 ESC 在界面上不可见,用户只看到一堆 `[32m`。
 */
describe('stripAnsi', () => {
  it('剥掉整条 SGR 着色序列,而不是只剥 ESC', () => {
    // ★ 和 stripControlChars 的差别就在这一条:那个函数会留下 `[31m`
    expect(stripAnsi('\u001B[31m危险\u001B[0m')).toBe('危险')
  })

  it('剥掉 vitest 那种嵌套的着色输出', () => {
    const line = ' \u001B[32m✓\u001B[39m src/a.test.ts \u001B[2m(7 tests)\u001B[22m'
    expect(stripAnsi(line)).toBe(' ✓ src/a.test.ts (7 tests)')
  })

  it('剥掉光标移动与清行 —— 进度条留下的那些', () => {
    expect(stripAnsi('\u001B[2K\u001B[1G下载中\u001B[?25l')).toBe('下载中')
  })

  it('剥掉 OSC(窗口标题),两种终止符都认', () => {
    expect(stripAnsi('\u001B]0;title\u0007ok')).toBe('ok')
    expect(stripAnsi('\u001B]8;;https://x\u001B\\link')).toBe('link')
  })

  it('被截断在半路的 OSC 不会把后面的正文放出来', () => {
    // 512KB 上限可能切在序列中间;留着未终止的 OSC 等于把后续输出全喂给终端
    expect(stripAnsi('ok\u001B]0;title-without-terminator')).toBe('ok')
  })

  it('剥掉字符集切换与落单的 ESC', () => {
    expect(stripAnsi('a\u001B(Bb\u001Bc')).toBe('abc')
    expect(stripAnsi('a\u001B')).toBe('a')
  })

  it('保留换行、制表、回车与非 ASCII —— 它们是正文', () => {
    expect(stripAnsi('第一行\n\t第二行\r\n中🙂')).toBe('第一行\n\t第二行\r\n中🙂')
  })

  it('不碰长得像转义序列的普通文本', () => {
    expect(stripAnsi('arr[0-9] 和 [31m 本身不是转义')).toBe('arr[0-9] 和 [31m 本身不是转义')
  })

  it('空字符串', () => {
    expect(stripAnsi('')).toBe('')
  })
})

describe('clampWithEllipsis', () => {
  it('不超长时原样返回', () => {
    expect(clampWithEllipsis('短', 10)).toBe('短')
  })

  it('恰好等于上限时不截断', () => {
    expect(clampWithEllipsis('12345', 5)).toBe('12345')
  })

  /** ★ 静默截断更糟:一段被砍掉一半的正文读起来仍然通顺 */
  it('超长时截断并留标记', () => {
    expect(clampWithEllipsis('1234567890', 8)).toBe('12345...')
  })

  it('结果长度不超过上限', () => {
    for (const max of [3, 4, 5, 10, 64]) {
      expect(clampWithEllipsis('x'.repeat(200), max).length, `max=${max}`).toBeLessThanOrEqual(max)
    }
  })

  it('自定义标记', () => {
    // 标记本身占 4 个字符,所以上限 8 只留得下 4 个正文字符
    expect(clampWithEllipsis('1234567890', 8, '(截断)')).toBe('1234(截断)')
  })

  /** 上限比标记还短时不能产出负数长度的 slice */
  it('上限小于标记长度时只剩标记', () => {
    expect(clampWithEllipsis('1234567890', 2)).toBe('...')
    expect(clampWithEllipsis('1234567890', 0)).toBe('...')
  })

  it('上限为 0 且内容为空时不加标记', () => {
    expect(clampWithEllipsis('', 0)).toBe('')
  })
})
