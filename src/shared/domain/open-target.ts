/**
 * 「打开方式」—— 用本机已装的文件管理器 / IDE / 终端打开一个工作区文件。
 *
 * 这个文件只放**两端都要认的形状**:目标 id、图标 id、探测结果的类型。
 * 「这台机器上装了哪些 IDE」是主进程的事(见 `main/system/open-with.ts`),
 * 渲染层只负责把它画出来 —— 它拿不到、也不需要拿到任何绝对路径
 * (`workspace-file.ts` 那条「不向渲染层返回磁盘绝对路径」的约定在这里继续成立,
 * 所以「复制绝对路径」也由主进程直接写剪贴板,而不是把路径递过来让渲染层自己写)。
 *
 * ★ `label` 是**产品名,不翻译**("VS Code"、"Rider"、"Ghostty")—— 和模型名、
 *   供应商名同一条规矩。两个通用目标(文件管理器 / 终端)的 label 是空串,
 *   文案由渲染层按 i18n 出:系统文件管理器叫什么各平台不同
 *   (访达 / 文件资源管理器 / 文件),那不是我们的产品名,不该跟着应用语言走。
 */

/**
 * 图标 id。
 *
 * ★ 这是一个**闭合联合**,`components/brand/EditorIcon.tsx` 里那张表按它
 *   `Record<…>` 展开 —— 加一个 IDE 却忘了配字形,编译期就挂,而不是界面上
 *   出现一颗空白图标(和 `ProviderIcon` 的 `MARK` 同一条规矩)。
 */
export type OpenTargetIcon =
  | 'file-manager'
  | 'terminal'
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'zed'
  | 'sublime'
  | 'intellij'
  | 'pycharm'
  | 'webstorm'
  | 'goland'
  | 'clion'
  | 'rider'
  | 'phpstorm'
  | 'rubymine'
  | 'androidstudio'
  | 'xcode'

/** 系统文件管理器。走 `shell.showItemInFolder`,不需要任何可执行文件,所以恒可用。 */
export const REVEAL_TARGET_ID = 'reveal'
/** 终端。**打开的是文件所在目录**,不是文件本身。 */
export const TERMINAL_TARGET_ID = 'terminal'

/**
 * 一个可用的打开方式。
 *
 * `id` 是稳定标识(主进程侧那张表的键),渲染层把它原样回传 —— 它不携带任何
 * 路径或命令,主进程收到之后只拿它**查表**,查不到就拒。
 */
export interface OpenTarget {
  id: string
  /** 产品名,不翻译;两个通用目标为空串(见文件头) */
  label: string
  icon: OpenTargetIcon
}

/** 「复制路径」的两档。`relative` 是**工作区相对**写法(工作区外的文件就是它的绝对路径)。 */
export type WorkspacePathKind = 'absolute' | 'relative'
