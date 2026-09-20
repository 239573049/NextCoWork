/**
 * Markdown Studio 插件的**逻辑侧** —— 跑在隐藏的插件宿主窗口里。
 *
 * ## 它为什么几乎是空的
 *
 * 与 `acme.image-studio` 同一分工:视图与宿主之间的文件读写走
 * `PluginViewFrame` 的文档通道(ncw:doc:ready/open/save),markdown 是纯文本,
 * 通道开箱即用 —— 逻辑侧在这条链路上没有角色,多绕一跳 IPC 只会更慢。
 *
 * ## 也不贡献命令
 *
 * 需求只有「接管 .md / .markdown 的打开」:认领靠 `customEditors` 的
 * filenamePattern,不需要「新建文档」入口(那是一次会失败的承诺 —— 视图
 * 没有开新文件的通道,画出来的按钮兑现不了)。
 *
 * ★ 文件存在仅因清单必须有 `main`:激活事件触发时宿主会加载它,空转即可。
 */
import * as ncw from 'nextcowork'

export function activate(_context: ncw.ExtensionContext): void {
  /* 有意空实现 —— 见文件头。 */
}

export function deactivate(): void {
  /* 无常驻资源。 */
}
