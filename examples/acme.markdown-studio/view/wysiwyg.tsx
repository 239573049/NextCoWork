/**
 * 所见即所得编辑器 —— Milkdown(ProseMirror)的真·富文本编辑。
 *
 * ## 与 CodeMirror 源码编辑器的关系
 *
 * **同一份 `text` 状态,两个视图。** 进入此模式时用当前 markdown 新建编辑器
 * (Milkdown 只在 mode==='wysiwyg' 时挂载 —— 进出都是「以当前文本重建」,
 * 不存在双编辑器互相同步的拉锯);编辑期间 `listener` 插件每次产出
 * markdown 都回写 `text`,于是自动保存、状态栏、大纲、退出切回的源码,
 * 全部走原有管道,这里不另开任何一条数据通路。
 *
 * ## 排版为什么直接复用 .md-body
 *
 * ProseMirror 的 contentDOM 渲染标准标签(h1/p/ul/table…),预览的排版
 * 样式是标签选择器 —— 同一个类名套上去,编辑态与预览态自然长得一样,
 * 这正是「所见即所得」的字面定义。这里只补编辑器 chrome:占位、选中、
 * 光标,以及 milkdown 各 preset 自带的任务列表复选框、表格编辑手柄。
 *
 * ## 有意不包含的
 *
 * - slash 菜单 / block 拖拽手柄(v1 用输入规则与键盘;加上它们要把
 *   crepe 那套 UI 样式整套搬进来 —— 那是另一档体量,要时再加);
 * - mermaid 的就地渲染:围栏代码块在编辑态保持为代码(预览态照常出图)。
 */
import { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, defaultValueCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { math } from '@milkdown/plugin-math'
/*
  milkdown 自带的 PM 基底样式(光标/占位/换行)与表格编辑样式。
  ★ 这两份必须显式引:esbuild 会抽进 main.css,不引的话编辑器能跑,
  但选中态、表格手柄全部没有样式 —— 症状是「看着能用,一选中就迷失」。
*/
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'

export interface WysiwygEditorProps {
  /** 进入此模式时的初始 markdown。此后文本的所有权在编辑器,经 onChange 回写。 */
  initial: string
  onChange: (markdown: string) => void
  /**
   * 大纲跳转的命中文本 —— WYSIWYG 没有「行」的概念,父级改文本匹配:
   * 每次 set 时滚动 contentDOM 里匹配的标题到视口(尽力而为,见 main.tsx)。
   */
  scrollSignal: { text: string; stamp: number } | null
}

function MilkdownEditor(props: WysiwygEditorProps): React.ReactElement {
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange

  useEditor((root) => {
    const editor = Editor.make()
    editor.config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, props.initial)
      ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
        onChangeRef.current(markdown)
      })
    })
    return editor
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(math)
  }, [])

  return <Milkdown />
}

function EditorWithScroll(props: WysiwygEditorProps): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (props.scrollSignal === null) return
    const wrap = wrapRef.current
    if (wrap === null) return
    const stripped = props.scrollSignal.text.replace(/[*_`~]/g, '')
    for (const element of wrap.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if ((element.textContent ?? '').replace(/[*_`~]/g, '') === stripped) {
        element.scrollIntoView({ block: 'start' })
        break
      }
    }
  }, [props.scrollSignal])

  return (
    <div className="wysiwyg-pane" ref={wrapRef}>
      <div className="md-body editor-surface">
        <MilkdownProvider>
          <MilkdownEditor {...props} />
        </MilkdownProvider>
      </div>
    </div>
  )
}

export const WysiwygEditor = EditorWithScroll
