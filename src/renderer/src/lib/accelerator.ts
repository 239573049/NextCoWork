/**
 * Electron 加速键字符串 → 界面上显示的样子。
 *
 * 从 `shell/InnerTabBar.tsx` 里抽出来的:内层 Tab 的 `+` 菜单、设置浮层导航栏
 * 顶上那行「设置 ⌘,」、以后的命令面板,三处显示的是同一套东西,而
 * `'CmdOrCtrl+N'` 这种写法只有主进程契约里才有意义,不能直接印给用户看。
 *
 * ★ **mac 上修饰键之间不带 `+`**,这是抽取时顺手修掉的一个 bug:原来的实现
 * 只 replace 掉 `'CmdOrCtrl'` 这个词,`'CmdOrCtrl+N'` 渲染出来是 `⌘+N`,
 * 而参考图和 macOS 系统菜单一律是 `⌘N`。`'CmdOrCtrl+,'` 更明显 —— `⌘+,`
 * 读起来像「⌘ 加 逗号」两个键。非 mac 反过来,`Ctrl+N` 的 `+` 必须留着。
 *
 * ★ `isMac` 是**参数**不是纯粹的模块常量:vitest 跑在 `environment: 'node'`,
 * 那里没有 `navigator`,模块级直接 `navigator.platform.toLowerCase()` 会在
 * import 的瞬间抛。默认值取自环境探测,测试传死值。
 */
const IS_MAC =
  typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

/** mac:修饰键换成字形,彼此紧贴 */
const MAC_SYMBOL: Readonly<Record<string, string>> = {
  CmdOrCtrl: '⌘',
  Cmd: '⌘',
  Command: '⌘',
  Ctrl: '⌃',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧'
}

/** 其他平台:保留单词与 `+` */
const PC_SYMBOL: Readonly<Record<string, string>> = {
  CmdOrCtrl: 'Ctrl',
  Cmd: 'Ctrl',
  Command: 'Ctrl',
  Ctrl: 'Ctrl',
  Control: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift'
}

export function prettyAccelerator(
  accelerator: string | undefined,
  isMac: boolean = IS_MAC
): string | undefined {
  if (accelerator === undefined) return undefined

  // `'CmdOrCtrl++'`(键位本身就是加号)split 出来末尾是两个空串 —— 只保留最后
  // 那个,再在 map 里还原成 `'+'`。中间的空串是畸形输入,直接丢掉。
  const parts = accelerator
    .split('+')
    .filter((p, i, all) => p !== '' || i === all.length - 1)

  const table = isMac ? MAC_SYMBOL : PC_SYMBOL
  const mapped = parts.map((p) => (p === '' ? '+' : (table[p] ?? p)))
  return mapped.join(isMac ? '' : '+')
}
