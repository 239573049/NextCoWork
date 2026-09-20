/**
 * Image Studio 插件的**逻辑侧** —— 跑在隐藏的插件宿主窗口里。
 *
 * ## 它为什么几乎是空的
 *
 * 这个插件的全部价值都在视图 iframe 里(编辑器画布),而视图与宿主之间的
 * 文件读写走的是 `PluginViewFrame` 的文档通道:`ncw:doc:ready/open/save`,
 * 由宿主按 Tab 绑定代读代写。**逻辑侧在这条链路上没有角色** —— 同
 * `acme.excalidraw` 的分工:让文件字节绕一圈 iframe → 逻辑侧 → 主进程
 * 只会多两跳 IPC,而这里连「转发」都无活可干。
 *
 * ## 也不贡献命令
 *
 * 需求明确只要「接管图片文件的打开」:打开由 `customEditors` 的
 * filenamePattern 认领,不需要「新建图片」入口。往 `tabBar/new` 加一个
 * 空白画布命令是画出来的每个控件都要兑现的承诺,这里不画。
 *
 * ★ 保留这个文件的唯一原因是清单必须有 `main`:激活事件
 * `onCustomEditor:image-studio.editor` 触发时宿主会加载它。activate
 * 空转即可,不注册任何东西也就没有需要 dispose 的资源。
 */
import * as ncw from 'nextcowork'

export function activate(_context: ncw.ExtensionContext): void {
  /* 有意空实现 —— 见文件头。 */
}

export function deactivate(): void {
  /* 无常驻资源。 */
}
