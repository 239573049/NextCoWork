/**
 * 视图 —— 跑在 `ncw-plugin://__PUBLISHER__.__NAME__` 的 iframe 里。
 *
 * ## 这里没有 React 依赖,是**故意**的
 *
 * `react` / `react-dom` / `nextcowork/ui` / `nextcowork/view` 全部由宿主经
 * import map 下发,打包时标成 external(见 package.json 的 `views` 字段与
 * `nextcowork-plugin build`)。
 *
 * 把它们打进 bundle 的后果:
 * - 自带 React → 运行期两份实例,症状是 "Invalid hook call",而报错位置指向
 *   你自己的组件,几乎不可能反推到真正的原因;
 * - 自带 `nextcowork/view` → 代码跑得通,但它和宿主之间那条 postMessage 通道
 *   永远没人接 —— 编辑器打开后一片空白,零报错。
 *
 * ## 样式也不用引
 *
 * `nextcowork/ui` 的那套 CSS 由宿主随这份 HTML 一起注入。你的控件因此和宿主
 * 界面**完全一致**,并且宿主改版时跟着变。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, EmptyState, TextArea } from 'nextcowork/ui'
import { mount, onDocument, saveDocument, setDirty } from 'nextcowork/view'

/** 攒够这么久没有新改动才落盘 —— 每次按键都写盘要过一遍主进程的校验与乐观锁。 */
const SAVE_DEBOUNCE_MS = 600

function Editor(): React.ReactNode {
  const [text, setText] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [dirty, setDirtyState] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    // ★ 返回值必须进 cleanup,否则重挂之后会叠一层监听(只在开发时显形)
    return onDocument((doc) => {
      setPath(doc.path)
      setText(doc.data)
    })
  }, [])

  const save = useCallback((next: string) => {
    saveDocument(next).then(
      () => { setDirtyState(false); setDirty(false) },
      // 失败多半是别人在你编辑期间改了同一个文件。**别重试** —— 重试会盖掉对方。
      () => { setDirtyState(true) }
    )
  }, [])

  const onChange = useCallback((next: string) => {
    setText(next)
    setDirtyState(true)
    // ★ 宿主的「关 Tab 之前问一句」全靠这一行。不报 = 用户的改动静默消失。
    setDirty(true)
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => { save(next) }, SAVE_DEBOUNCE_MS)
  }, [save])

  // 文档还没到(宿主在读盘)。画空态而不是空白 —— 空白看起来像坏了。
  if (text === null) return <EmptyState title="…" hint={path} />

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">{path}</span>
        <Button variant="accent" size="sm" disabled={!dirty} onClick={() => { save(text) }}>
          Save
        </Button>
      </div>
      <TextArea value={text} onChange={onChange} className="min-h-0 flex-1" />
    </div>
  )
}

mount(<Editor />)
