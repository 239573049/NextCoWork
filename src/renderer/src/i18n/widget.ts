/**
 * 内置可视化 widget 的文案。
 *
 * 只有一条,但仍然单独成文件:它属于 `visualize_*` 那条链路,而
 * `i18n/index.tsx` 已经三千多行(AGENTS §15.3「新代码别往里加」)。
 * 照 `usage.ts` / `git.ts` 的先例,域一独立就搬出来。
 *
 * ★ 这里**没有**"正在生成""加载中"这类句子:widget 生成期的提示词是
 * **模型给的**(`loading_messages` 参数,语言跟随用户),那是它的产物,
 * 不该由我们翻译 —— 翻译了就会与模型正在写的内容语言不一致。
 *
 * ★ 也**没有**失败文案:失败走的是工具结果本身(`OutputBlock` 渲染
 * `output.content`),那条路径已经有自己的文案体系。
 */

export const widgetZh = {
  /** iframe 的无障碍名字。模型给的 `title` 还没流到时的兜底 —— 空的无障碍名字会被读屏软件念成路径。 */
  'widget.untitled': '可视化内容'
}

export const widgetEn = {
  'widget.untitled': 'Visualization'
}
