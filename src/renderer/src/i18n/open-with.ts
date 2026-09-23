/**
 * 「打开方式」下拉的文案(审查卡文件行 / 文件视图工具条 / 图片灯箱 / 文件树行菜单)。
 *
 * 单独一个文件 —— 照 `git.ts` / `usage.ts` / `provider-accounts.ts` 的先例(§6.3):
 * `index.tsx` 已经三千多行,新的域不再往里堆。
 *
 * ★ **菜单里那几行 IDE 名不是这里出的。** "VS Code" / "Rider" / "Ghostty" 是
 *   产品名,和模型名、供应商名一样不翻译;它们由主进程随探测结果一起下发
 *   (`shared/domain/open-target.ts` 的 `label`)。这里只有两件事:
 *   两个**通用**目标的名字(系统文件管理器各平台叫法不同,不该跟着应用语言走的是
 *   产品名,该跟着走的是「文件管理器」这个概念),以及外围那些标签。
 *
 * ★ `openWithEn` **不要**标 `Record<keyof typeof openWithZh, string>`:
 *   带插值的条目值是函数不是 string,标了整张表都不匹配。zh/en 的键对齐由
 *   `index.test.ts` 在运行时逐键比对。
 *
 * 这一域**目前没有带插值的条目**(所以不声明 `Params` 那个别名)——
 * 加带参数的句子时照 `provider-accounts.ts` 补一个 `type Params = …`。
 */

export const openWithZh = {
  'openWith.label': '打开方式',
  'openWith.reveal': '文件管理器',
  'openWith.terminal': '终端',
  /** 终端打开的是**目录**。不写这一句的话用户会以为它要打开那个文件。 */
  'openWith.terminalHint': '在此文件所在目录打开终端',
  'openWith.copyAbsolute': '复制绝对路径',
  'openWith.copyRelative': '复制相对路径',
  'openWith.copied': '已复制路径',
  'openWith.empty': '没有检测到可用的编辑器',
  'openWith.openFailed': '无法用这个程序打开，请检查它是否仍然安装。'
}

export const openWithEn = {
  'openWith.label': 'Open with',
  'openWith.reveal': 'File manager',
  'openWith.terminal': 'Terminal',
  'openWith.terminalHint': 'Open a terminal in this file’s folder',
  'openWith.copyAbsolute': 'Copy absolute path',
  'openWith.copyRelative': 'Copy relative path',
  'openWith.copied': 'Path copied',
  'openWith.empty': 'No editor detected',
  'openWith.openFailed': 'Could not open with this app. Check that it is still installed.'
}
