/**
 * `.note` 文件的编辑器视图 —— 跑在 `ncw-plugin://acme.note-editor` 的 iframe 里。
 *
 * ## 这个文件想证明的事
 *
 * **插件可以用 React 写界面,而且不自带 React、不自带控件、不写一行样式。**
 *
 * 对照 `examples/acme.excalidraw/view/main.tsx`(同一件事的老做法):
 *
 * | | 老做法 | 这里 |
 * |---|---|---|
 * | React | `devDependencies` 里一份,打进 bundle | 宿主经 import map 下发,**external** |
 * | 控件 | 自己写 `<button className="...">`,照着宿主的样子调 | `import { Button } from 'nextcowork/ui'` |
 * | 样式 | 自己写 `<style>`,读 `--ncw-*` 变量 | 宿主随 HTML 注入 `/__ui.css`,**不用引** |
 * | 文档通道 | 手写 `addEventListener('message')` + 比对 origin | `onDocument` / `saveDocument` |
 * | 主题 | 自己声明 `__ncwTheme` 全局、接 `ncw:theme` | 控件自己跟着走 |
 *
 * 结果是这个包**一个 npm 依赖都没有**(连 react 都不装),`node build.mjs`
 * 直接就能出产物。
 *
 * ## 仍然要自己管的两件事
 *
 * 1. **保存节流**。每次按键都存盘的话,每一次都要过一遍主进程的路径校验和
 *    乐观锁;这里攒 600ms。
 * 2. **脏状态**。`setDirty` 是宿主「关 Tab 之前问一句」的唯一依据 ——
 *    不报的话,用户没存的字会在关 Tab 那一刻无声消失。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, EmptyState, TextArea, cn } from 'nextcowork/ui'
import { mount, onDocument, saveDocument, setDirty } from 'nextcowork/view'

const SAVE_DEBOUNCE_MS = 600

function NoteEditor(): React.ReactNode {
  const [text, setText] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [status, setStatus] = useState<'clean' | 'dirty' | 'saving' | 'failed'>('clean')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    /*
      ★ 返回值必须进 cleanup。漏了的话,视图热重载或重挂之后会叠一层监听,
      表现为一次 `ncw:doc:open` 触发 N 次 setState —— 而且只在开发时出现。
    */
    return onDocument((doc) => {
      setPath(doc.path)
      setText(doc.data)
    })
  }, [])

  const save = useCallback((next: string) => {
    setStatus('saving')
    saveDocument(next).then(
      () => { setStatus('clean'); setDirty(false) },
      /*
        失败最常见的原因是**别人在你编辑期间改了同一个文件**(宿主拿 revision 挡的)。
        这种时候不能重试 —— 重试会把对方的改动盖掉。停在 failed 上,让用户决定。
      */
      () => { setStatus('failed') }
    )
  }, [])

  const onChange = useCallback((next: string) => {
    setText(next)
    setStatus('dirty')
    setDirty(true)
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => { save(next) }, SAVE_DEBOUNCE_MS)
  }, [save])

  // 文档还没到(宿主要读盘)。画空态而不是空白 —— 空白看起来像坏了。
  if (text === null) {
    return <EmptyState title="…" hint={path} />
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">{path}</span>
        <span
          className={cn(
            'text-[11px] tabular-nums',
            status === 'failed' ? 'text-danger' : 'text-fg-faint'
          )}
        >
          {STATUS_TEXT[status]}
        </span>
        <Button
          variant="accent"
          size="sm"
          disabled={status === 'clean' || status === 'saving'}
          onClick={() => {
            if (timer.current !== undefined) clearTimeout(timer.current)
            save(text)
          }}
        >
          保存
        </Button>
      </div>
      <TextArea value={text} onChange={onChange} className="min-h-0 flex-1" />
    </div>
  )
}

const STATUS_TEXT: Record<'clean' | 'dirty' | 'saving' | 'failed', string> = {
  clean: '已保存',
  dirty: '未保存',
  saving: '保存中…',
  failed: '保存失败 —— 文件可能已被改动'
}

mount(<NoteEditor />)
