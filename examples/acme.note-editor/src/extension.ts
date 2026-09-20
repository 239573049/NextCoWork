/**
 * 逻辑侧 —— 这个插件几乎不需要它。
 *
 * 自定义编辑器是**声明式**的:`contributes.customEditors` 说了哪些文件由谁接管,
 * 宿主据此直接打开 `contributes.views` 里那个 HTML,并把文档通道接上。
 * 所以这里没有 `registerCustomEditor` 之类的调用 —— 那种 API 不存在,
 * 也不该存在(见 `shared/plugin/custom-editor.ts`:接管关系必须在安装时就看得见)。
 *
 * ★ 那为什么还要这个文件:`kind: "extension"` 的清单必须有 `main`,而且宿主会在
 * `onCustomEditor:` 事件到达时把它唤醒。空的 `activate` 是**有意**的 ——
 * 删掉这个文件会让整个包装不上(安装器查入口),而把它写成 `kind: "webapp"`
 * 也不行:零代码插件贡献不了自定义编辑器。
 */
export function activate(): void {
  // 有意为空。所有行为都在清单与视图里。
}

export function deactivate(): void {
  // 同上:没有需要释放的东西。视图的生命周期由宿主的 Tab 管。
}
