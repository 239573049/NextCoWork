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
 * 削掉 ANSI 转义序列(SGR 着色、光标移动、OSC 标题…),**保留可见正文**。
 *
 * 需求:`Bash` / `BashOutput` 捕获的是管道而不是 TTY,但很多 CLI 照样着色 ——
 * vitest 用的 picocolors 在 **win32 上无条件开色**,根本不看 isTTY。这些序列
 * 原样进模型上下文是纯噪声,而在卡片里 ESC 本身不可见,用户看到的是
 * 「`[32m✓ [39m src/... [2m(7 tests)`」这种读不下去的东西。
 *
 * 不满足会怎样:输出看上去「多了一堆方括号乱码」,且因为 ESC 不可见,
 * 从界面上完全看不出它是转义序列 —— 只会以为命令输出坏了。
 *
 * ★ 和 `stripControlChars` 分开,不合并:那个函数只削单个控制字符
 * (于是 `ESC[31m` 会留下 `[31m`,见 text.test.ts 里钉着的那条),
 * 这里削的是**整条序列**。系统提示词那条路要的是前者的边界,别互相替换。
 * ★ 终端(`terminal-host.ts` 的 PTY 数据)**绝不能过这个函数** —— xterm 靠这些
 * 序列画屏幕,剥掉等于把终端变成一段乱糟糟的纯文本。
 */
export function stripAnsi(s: string): string {
  /*
    四支,顺序有意义(先长后短,否则 OSC 的正文会被 CSI 那支从中间咬开):
    1. OSC「ESC ] … BEL」或「ESC ] … ESC \」:设置窗口标题、超链接。两种终止符
       都有实现在用;末尾那个美元符兜住「序列被 512KB 上限截在半路」的情况 ——
       留着一条未终止的 OSC,它后面的正文会被当成标题参数一起吃掉。
    2. CSI「ESC [ 参数 中间字节 终止字节」:着色(SGR)、清行、光标移动都在这里。
    3. nF「ESC 中间字节+ 终止字节」:ESC ( B 这类字符集切换。
    4. 其余两字符转义,以及落单的 ESC —— 剥不干净时留下的裸 ESC 在界面上不可见,
       等于又回到「看不出问题出在哪」的原点。
  */
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B(?:\][\s\S]*?(?:\u0007|\u001B\\|$)|\[[0-?]*[ -/]*[@-~]|[ -/]+[0-~]|[@-Z\\-_])?/g, '')
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
