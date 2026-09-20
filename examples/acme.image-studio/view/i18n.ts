/**
 * 视图侧的文案表。
 *
 * ## 为什么不复用包里的 `l10n/`
 *
 * 清单的 l10n bundle 是给**宿主**渲染的(菜单、Tab 标题),它经插件 catalog
 * 送进主窗口 —— 而这个 iframe 是跨源的,拿不到那份表。所以视图自带一份
 * zh/en 词典,按 `navigator.language` 选(宿主没有往视图注入应用语言的
 * 通道;读系统语言是这里的上界)。
 *
 * 需求:插件要能在中英两种环境下给人用;硬编码中文会让英文用户看到一屏
 * 看不懂的按钮。
 */
type Dict = Record<string, string>

const ZH: Dict = {
  'mode.preview': '预览',
  'mode.edit': '编辑',
  'tool.pan': '移动',
  'tool.crop': '裁剪',
  'tool.brush': '画笔',
  'tool.eraser': '橡皮',
  'tool.text': '文字',
  'tool.rotate': '旋转/翻转',
  'tool.adjust': '调整',
  'tool.resize': '尺寸',
  'tool.export': '保存',
  'action.undo': '撤销',
  'action.redo': '重做',
  'action.reset': '重置',
  'action.resetConfirm': '确认重置?',
  'action.save': '保存',
  'action.saveNow': '立即保存',
  'action.applyCrop': '应用裁剪',
  'action.cancelCrop': '取消裁剪',
  'action.rotateLeft': '左转 90°',
  'action.rotateRight': '右转 90°',
  'action.flipH': '水平翻转',
  'action.flipV': '垂直翻转',
  'adjust.brightness': '亮度',
  'adjust.contrast': '对比度',
  'adjust.saturate': '饱和度',
  'adjust.hue': '色相',
  'adjust.blur': '模糊',
  'adjust.grayscale': '灰度',
  'adjust.sepia': '棕褐',
  'adjust.invert': '反色',
  'adjust.angle': '角度',
  'adjust.reset': '恢复默认',
  'crop.ratio': '比例',
  'crop.ratio.free': '自由',
  'crop.ratio.original': '原始',
  'crop.hint': '在图上拖出裁剪范围,可拖动边与角调整',
  'resize.width': '宽度',
  'resize.height': '高度',
  'resize.lock': '锁定比例',
  'resize.apply': '应用',
  'resize.hint': '留空则按原始尺寸导出',
  'brush.color': '颜色',
  'brush.size': '粗细',
  'text.color': '颜色',
  'text.size': '字号',
  'text.content': '内容',
  'text.hint': '点击画面放置文字;拖动已放置的文字移动',
  'text.delete': '删除选中文字',
  'export.format': '格式',
  'export.quality': '质量',
  'export.sameFormat': '原格式',
  'export.pngNote': '该扩展名无法从画布编码,将按 PNG 字节写入(扩展名不变)',
  'export.gifNote': '动图仅取第一帧,保存后不再动',
  'export.jpegNote': 'JPEG 不支持透明,透明区域将填白',
  'state.saving': '保存中…',
  'state.saved': '已保存',
  'state.failed': '保存失败,点击重试',
  'state.dirty': '未保存',
  'empty.title': '打不开这张图',
  'empty.tooLarge': '图片超出工作区的大小上限(16MB),无法在这里预览或编辑。',
  'empty.bad': '文件读不出来,或不是浏览器能解码的图片格式。',
  'status.size': '{w} × {h} px',
  'status.zoom': '{percent}%',
  'status.bytes': '{size}',
  'status.frame': '第 1 帧',
  'fit': '适应窗口',
  'actual': '实际大小',
  'shortcut.zoom': '滚轮缩放 / 空格拖动平移'
}

const EN: Dict = {
  'mode.preview': 'Preview',
  'mode.edit': 'Edit',
  'tool.pan': 'Pan',
  'tool.crop': 'Crop',
  'tool.brush': 'Brush',
  'tool.eraser': 'Eraser',
  'tool.text': 'Text',
  'tool.rotate': 'Rotate / flip',
  'tool.adjust': 'Adjust',
  'tool.resize': 'Resize',
  'tool.export': 'Save',
  'action.undo': 'Undo',
  'action.redo': 'Redo',
  'action.reset': 'Reset',
  'action.resetConfirm': 'Confirm reset?',
  'action.save': 'Save',
  'action.saveNow': 'Save now',
  'action.applyCrop': 'Apply crop',
  'action.cancelCrop': 'Cancel crop',
  'action.rotateLeft': 'Rotate left 90°',
  'action.rotateRight': 'Rotate right 90°',
  'action.flipH': 'Flip horizontal',
  'action.flipV': 'Flip vertical',
  'adjust.brightness': 'Brightness',
  'adjust.contrast': 'Contrast',
  'adjust.saturate': 'Saturation',
  'adjust.hue': 'Hue',
  'adjust.blur': 'Blur',
  'adjust.grayscale': 'Grayscale',
  'adjust.sepia': 'Sepia',
  'adjust.invert': 'Invert',
  'adjust.angle': 'Angle',
  'adjust.reset': 'Reset',
  'crop.ratio': 'Ratio',
  'crop.ratio.free': 'Free',
  'crop.ratio.original': 'Original',
  'crop.hint': 'Drag on the image to set the crop, then drag edges or corners',
  'resize.width': 'Width',
  'resize.height': 'Height',
  'resize.lock': 'Lock ratio',
  'resize.apply': 'Apply',
  'resize.hint': 'Leave empty to export at natural size',
  'brush.color': 'Color',
  'brush.size': 'Size',
  'text.color': 'Color',
  'text.size': 'Size',
  'text.content': 'Content',
  'text.hint': 'Click the canvas to place text; drag placed text to move',
  'text.delete': 'Delete selected text',
  'export.format': 'Format',
  'export.quality': 'Quality',
  'export.sameFormat': 'Same as source',
  'export.pngNote': 'This extension cannot be encoded from canvas; bytes will be written as PNG (extension unchanged)',
  'export.gifNote': 'Animated GIF: only the first frame is kept',
  'export.jpegNote': 'JPEG has no transparency; transparent areas become white',
  'state.saving': 'Saving…',
  'state.saved': 'Saved',
  'state.failed': 'Save failed — click to retry',
  'state.dirty': 'Unsaved',
  'empty.title': 'Cannot open this image',
  'empty.tooLarge': 'The file exceeds the workspace image limit (16 MB).',
  'empty.bad': 'The file could not be read or is not a decodable image format.',
  'status.size': '{w} × {h} px',
  'status.zoom': '{percent}%',
  'status.bytes': '{size}',
  'status.frame': 'frame 1',
  'fit': 'Fit',
  'actual': '100%',
  'shortcut.zoom': 'Wheel to zoom / space-drag to pan'
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
