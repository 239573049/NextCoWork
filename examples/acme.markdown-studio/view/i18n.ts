/**
 * 视图侧文案表 —— 结构与理由同 `../acme.image-studio/view/i18n.ts`:
 * 清单的 l10n bundle 归宿主渲染,跨源 iframe 拿不到,视图自带 zh/en 词典,
 * 按 `navigator.language` 选。
 */
type Dict = Record<string, string>

const ZH: Dict = {
  'mode.edit': '编辑',
  'mode.wysiwyg': '所见即所得',
  'mode.preview': '预览',
  'toolbar.heading': '标题',
  'toolbar.bold': '粗体',
  'toolbar.italic': '斜体',
  'toolbar.strike': '删除线',
  'toolbar.link': '链接',
  'toolbar.image': '图片',
  'toolbar.code': '行内代码',
  'toolbar.codeBlock': '代码块',
  'toolbar.quote': '引用',
  'toolbar.list': '列表',
  'toolbar.ordered': '有序列表',
  'toolbar.task': '任务列表',
  'toolbar.table': '表格',
  'toolbar.hr': '分割线',
  'toolbar.mermaid': 'Mermaid 图表',
  'toolbar.math': '公式',
  'outline.title': '大纲',
  'outline.empty': '没有标题',
  'action.save': '保存',
  'action.find': '搜索',
  'state.saving': '保存中…',
  'state.saved': '已保存',
  'state.failed': '保存失败,点击重试',
  'state.dirty': '未保存',
  'empty.title': '打不开这个文件',
  'empty.bad': '文件读不出来,或超出了工作区的文本大小上限(2MB)。',
  'status.words': '{count} 词',
  'status.chars': '{count} 字符',
  'status.lines': '{count} 行',
  'status.readMinutes': '{count} 分钟',
  'status.cursor': '行 {line},列 {col}',
  'linkHint': 'iframe 内链接不导航;按住 ⌘/Ctrl 点击可复制地址',
  'mermaid.failed': '图表渲染失败'
}

const EN: Dict = {
  'mode.edit': 'Edit',
  'mode.wysiwyg': 'WYSIWYG',
  'mode.preview': 'Preview',
  'toolbar.heading': 'Heading',
  'toolbar.bold': 'Bold',
  'toolbar.italic': 'Italic',
  'toolbar.strike': 'Strikethrough',
  'toolbar.link': 'Link',
  'toolbar.image': 'Image',
  'toolbar.code': 'Inline code',
  'toolbar.codeBlock': 'Code block',
  'toolbar.quote': 'Blockquote',
  'toolbar.list': 'Bullet list',
  'toolbar.ordered': 'Numbered list',
  'toolbar.task': 'Task list',
  'toolbar.table': 'Table',
  'toolbar.hr': 'Divider',
  'toolbar.mermaid': 'Mermaid diagram',
  'toolbar.math': 'Math',
  'outline.title': 'Outline',
  'outline.empty': 'No headings',
  'action.save': 'Save',
  'action.find': 'Find',
  'state.saving': 'Saving…',
  'state.saved': 'Saved',
  'state.failed': 'Save failed — click to retry',
  'state.dirty': 'Unsaved',
  'empty.title': 'Cannot open this file',
  'empty.bad': 'The file could not be read, or exceeds the workspace text limit (2 MB).',
  'status.words': '{count} words',
  'status.chars': '{count} chars',
  'status.lines': '{count} lines',
  'status.readMinutes': '{count} min',
  'status.cursor': 'Ln {line}, Col {col}',
  'linkHint': 'Links do not navigate inside the iframe; ⌘/Ctrl-click copies the URL',
  'mermaid.failed': 'Diagram failed to render'
}

const zh = (): boolean =>
  (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')) ||
  document.documentElement.lang.toLowerCase().startsWith('zh')

const table = zh() ? ZH : EN

/** `{param}` 插值;缺参原样保留花括号,方便发现漏传。 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = table[key] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  )
}
