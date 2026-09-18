/**
 * 「这个文件该由哪个插件打开」—— `contributes.customEditors` 的**消费端**。
 *
 * ## 为什么需要这个文件
 *
 * 声明这一侧一直是通的:清单能写 `selector[].filenamePattern`、校验认得它、
 * `InnerTab` 有 `kind: 'custom'`、落盘认、`CustomEditorView` 画得出来。
 * 缺的是**读的那一侧** —— 在这个文件出现之前,全仓库没有任何一处读过
 * `filenamePattern`。于是从文件树双击 `.excalidraw` 打开的是一屏原始 JSON,
 * 而插件自己调 `tabs.openCustomEditor` 却能开出画布。同一个文件,两种结果,
 * 取决于是谁发起的。
 *
 * ## 为什么不编译成正则
 *
 * `filenamePattern` 是**第三方清单里的任意字符串**:校验那一关只要求它非空
 * (`manifest.ts` 的 `parseContributes`)。把它交给 `new RegExp` 等于让任何一份
 * 装进来的插件都能塞一个灾难性回溯的模式进来 —— 而触发点是「用户点开一个文件」
 * 这种每天几十次的操作。
 *
 * 所以这里是**两指针**匹配,和 `shared/agent/permission-rule.ts` 的 `wildcardMatch`
 * 同一个立场:最坏 O(n·m),没有回溯可言。
 */
import type { InstalledPlugin } from './state'
import { isRunnable } from './state'

/**
 * `*` 匹配任意段(含空),其余字符逐字比。**没有 `?`,也没有 `{a,b}`** ——
 * 现实里的 selector 全是 `*.ext` 这一种形状,多认一种语法就多一种作者以为
 * 支持、实际不支持的写法。
 *
 * ★ 两指针 + 回退点,不递归:`star`/`mark` 记住「上一个 `*` 匹到哪」,失配时
 * 让那个 `*` 多吃一个字符再来。连续的 `*` 自然被同一个回退点吸收。
 */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === text[t])) {
      p += 1
      t += 1
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p
      mark = t
      p += 1
    } else if (star !== -1) {
      p = star + 1
      mark += 1
      t = mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1
  return p === pattern.length
}

/**
 * 一个工作区相对路径命中这条 `filenamePattern` 吗。
 *
 * ★ **带 `/` 的模式匹整条路径,不带的只匹文件名。** 这是 VS Code 的规矩,
 * 而且是唯一讲得通的一种:`*.excalidraw` 若按整条路径匹,`a/b.excalidraw`
 * 会因为路径里那个 `/` 被 `*` 吃掉而恰好命中 —— 看起来没问题,直到有人写
 * `drawings/*.excalidraw` 却发现它同样匹配了 `drawings/old/x.excalidraw`。
 *
 * ★ 扩展名**不区分大小写**(`.EXCALIDRAW` 也算),但路径的其余部分逐字比:
 * macOS 与 Windows 的文件系统本身就不区分,而这里若区分,用户会看到
 * 「同一个文件换个大小写就打不开了」。为简单起见整体按小写比 —— selector
 * 的实际用法是后缀,不是路径前缀。
 */
export function matchesFilenamePattern(pattern: string, path: string): boolean {
  if (pattern === '' || path === '') return false
  const normalized = path.replaceAll('\\', '/')
  const subject = pattern.includes('/') ? normalized : (normalized.split('/').pop() ?? normalized)
  return wildcardMatch(pattern.toLowerCase(), subject.toLowerCase())
}

/** 选中的编辑器 —— 两样**都要**,原因见 `domain/tab.ts` 里 `kind: 'custom'` 的注释。 */
export interface CustomEditorChoice {
  pluginId: string
  viewType: string
}

/**
 * 谁来打开这个文件。没有插件认领就返回 `null`,调用方退回内置的 `doc`。
 *
 * ★ **只在跑得起来的插件里挑。** 禁用 / 装载失败 / 待批准的插件仍然留在
 * catalog 里(详情页要显示它们),但让它们参与认领等于「禁用了插件,文件
 * 却还是打不开」。复用 `isRunnable`,而不是在这里再抄一遍那个表达式。
 *
 * ★ **结果必须是确定的。** 两个插件都声明了 `*.excalidraw` 时,按
 * `priority` 再按插件 id 排序 —— 不能直接取 catalog 里的第一个:那个顺序
 * 来自磁盘扫描,装一个不相干的插件就可能让已经开着的文件换一个编辑器。
 */
export function pickCustomEditor(
  plugins: readonly InstalledPlugin[],
  path: string
): CustomEditorChoice | null {
  const candidates: { choice: CustomEditorChoice; preferred: boolean }[] = []
  for (const plugin of plugins) {
    if (!isRunnable(plugin)) continue
    for (const editor of plugin.manifest.contributes.customEditors) {
      if (!editor.selector.some((s) => matchesFilenamePattern(s.filenamePattern, path))) continue
      candidates.push({
        choice: { pluginId: plugin.id, viewType: editor.viewType },
        // `priority` 省略时等同 'default' —— 见 manifest.ts 的解析
        preferred: (editor.priority ?? 'default') === 'default'
      })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
    if (a.choice.pluginId !== b.choice.pluginId) return a.choice.pluginId < b.choice.pluginId ? -1 : 1
    return a.choice.viewType < b.choice.viewType ? -1 : 1
  })
  return candidates[0]?.choice ?? null
}
