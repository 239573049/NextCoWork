/**
 * `nextcowork/view` —— 插件**视图侧**的运行时(跑在视图 iframe 里)。
 *
 * ## 和 `nextcowork` 不是一回事
 *
 * `nextcowork` 是**插件逻辑**(`main` 指向的那个模块)用的,跑在一个隐藏的宿主
 * 页面里,有 preload、有权限链、能读写文件跑命令。
 *
 * 这一套是**视图**用的。视图 iframe 没有 preload,和宿主之间只有一条 postMessage
 * 通道 —— 它能做的事只有:拿到自己绑定的那个文件、存回去、报告脏状态、跟随主题。
 * 想做别的(读别的文件、跑命令、联网),让插件逻辑去做,视图通过你自己的
 * 消息约定跟它说话。
 *
 * ## 模块从哪来
 *
 * 宿主经 import map 下发,**不要装进 devDependencies**,也不要打进你的 bundle:
 * 打进去就是第二份实例,而它和宿主之间那条通道不会工作。
 * 打包时把这几个名字标成 external:
 *
 * ```js
 * external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'nextcowork/ui', 'nextcowork/view']
 * ```
 */
declare module 'nextcowork/view' {
  import type { ReactNode } from 'react'

  /** 宿主送过来的那份文档。 */
  export interface PluginDocument {
    /** 工作区相对路径。**只读** —— 保存时不需要、也不可以带上它。 */
    path: string
    /** 文本文件是正文;图片是 `data:` URL(可直接喂 `<img>` / canvas)。 */
    data: string
    /** 只在图片分支有。 */
    mime?: string
  }

  /**
   * 订阅这个视图绑定的文档,返回退订函数。
   *
   * ★ 调用它本身就会向宿主要一次文档,所以**只调一次**;
   * 在 React 里放进 `useEffect`,并且把返回值放进 cleanup。
   */
  export function onDocument(handler: (doc: PluginDocument) => void): () => void

  /**
   * 把内容存回这个视图绑定的文件。
   *
   * 失败最常见的原因是**别人在你编辑期间改了同一个文件**(宿主用 revision 挡的)。
   * 这种时候正确的做法是提示用户,不是重试 —— 重试会把对方的改动盖掉。
   *
   * `encoding: 'base64'` 是图片支线;宿主只允许用它覆写已分类为 image 的文件。
   */
  export function saveDocument(data: string, options?: { encoding?: 'base64' }): Promise<void>

  /**
   * 报告「我有 / 没有没存的改动」。
   *
   * ★ 宿主的「关 Tab 之前问一句」**全靠它**。不报的话,用户没存的改动会在关
   * Tab 那一刻静默消失 —— 而内置文档是会挽留的,两者行为不一致更难被发现。
   */
  export function setDirty(dirty: boolean): void

  export interface PluginTheme {
    appearance: 'light' | 'dark'
    motion: 'standard' | 'soft' | 'reduced' | 'off'
  }

  /**
   * 跟随宿主的深浅色 / 动效档位。
   *
   * ★ 大多数情况**用不到** —— `nextcowork/ui` 的控件和下发的那份 CSS 已经自己
   * 跟着走了。只有你自己画 canvas、或者用 Motion 写动画时才需要读它
   * (CSS 的 `prefers-reduced-motion` 管不住 WAAPI)。
   */
  export function useTheme(): PluginTheme

  /**
   * 挂载视图的根组件。
   *
   * ★ 不只是省三行:它保证根节点**在 document 里**。宿主注入的主题变量写在
   * `<html>` 上,挂在一个游离容器上的 React 树继承不到那些变量 ——
   * 症状是控件全无颜色,且零报错。
   *
   * 默认开 `StrictMode`:视图最常见的 bug 是 effect 里登记了监听却没退订,
   * 双次挂载当场就能让它暴露。
   */
  export function mount(node: ReactNode, options?: { strict?: boolean; container?: HTMLElement }): void
}

/**
 * `nextcowork/ui` —— **宿主自己的那套控件**,给插件视图直接用。
 *
 * ## 为什么用它,而不是自己画
 *
 * 这里每一个组件都是宿主界面上正在用的**同一份实现**,不是仿制品。于是:
 * 尺寸、圆角、hover 态、焦点环、无障碍属性、动效档位全都自动跟宿主一致,
 * 而且宿主改版时你的视图跟着变 —— 自己照着截图画的那一份不会。
 *
 * 样式由宿主随视图 HTML 一并注入(`/__ui.css`),**你不需要引任何 CSS**。
 *
 * ## 边界
 *
 * 这些组件**只画界面**。要改文件、跑命令、读剪贴板,走 `nextcowork/view` 的
 * 文档通道或者你自己插件逻辑侧的 `nextcowork` API —— 这个模块没有给 iframe
 * 开任何新口子。
 *
 * ## 缺了什么
 *
 * Toast 不在这里:它要宿主窗口的那个单例 store,打进视图只会得到一个永远空的
 * 列表。要提示用户,在插件逻辑里调 `ncw.window.showMessage()`。
 */
declare module 'nextcowork/ui' {
  import type { ReactNode, RefObject } from 'react'

  export type Tone = 'accent' | 'danger' | 'ghost'

  export function Button(props: {
    children: ReactNode
    onClick?: () => void
    /** 主动作 accent / 危险 danger / 中性 ghost(默认) */
    variant?: Tone
    size?: 'sm' | 'md'
    icon?: ReactNode
    disabled?: boolean
    className?: string
  }): ReactNode

  export function IconButton(props: {
    children: ReactNode
    /** 无障碍名字。图标按钮没有可见文字,**不给等于读屏用户听到一句"按钮"**。 */
    label: string
    onClick?: () => void
    size?: number
    active?: boolean
    disabled?: boolean
    className?: string
  }): ReactNode

  export function TextInput(props: {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    disabled?: boolean
    className?: string
  }): ReactNode

  export function TextArea(props: {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    rows?: number
    className?: string
  }): ReactNode

  export function NumberInput(props: {
    value: number
    onChange: (value: number) => void
    min?: number
    max?: number
    step?: number
    className?: string
  }): ReactNode

  export function Toggle(props: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }): ReactNode

  export function Slider(props: {
    value: number
    onChange: (value: number) => void
    min?: number
    max?: number
    step?: number
    className?: string
  }): ReactNode

  export function Segmented<T extends string>(props: {
    value: T
    options: { value: T; label: ReactNode }[]
    onChange: (value: T) => void
    className?: string
  }): ReactNode

  export type SelectOption = { value: string; label: string; disabled?: boolean }
  export function Select(props: {
    value: string
    options: SelectOption[]
    onChange: (value: string) => void
    className?: string
  }): ReactNode

  /**
   * 模态对话框。
   *
   * ★ 焦点陷阱与 Esc 关闭已经内建 —— 自己实现的模态十有八九会漏掉 Tab 键
   * 跑到背后那层去,而那是键盘用户唯一的出路。
   */
  export function Dialog(props: {
    title: string
    description?: string
    open: boolean
    onClose: () => void
    footer?: ReactNode
    width?: number
    children: ReactNode
  }): ReactNode

  export function EmptyState(props: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }): ReactNode
  export function ProgressBar(props: { value: number; className?: string }): ReactNode
  export function Spinner(props: { size?: number; className?: string }): ReactNode
  export function Tooltip(props: { label: string; children: ReactNode }): ReactNode

  export function Menu(props: {
    open: boolean
    onClose: () => void
    anchor: RefObject<HTMLElement | null>
    children: ReactNode
  }): ReactNode
  export function MenuItem(props: {
    children: ReactNode
    onClick?: () => void
    icon?: ReactNode
    danger?: boolean
    disabled?: boolean
  }): ReactNode
  export function MenuLabel(props: { children: ReactNode }): ReactNode
  export function MenuSeparator(): ReactNode

  /**
   * 条件类名合并(twMerge:后写的赢)。
   *
   * ★ 覆盖上面组件的样式时**用它**,别用字符串拼接:拼出来的 class 上会同时
   * 存在 `px-3` 和 `px-2`,谁赢取决于 CSS 生成顺序 ——
   * 症状是同样的代码在两次构建后表现不同。
   */
  export function cn(...parts: unknown[]): string

  export type MotionLevel = 'standard' | 'soft' | 'reduced' | 'off'
  /** 当前动效档位。自己用 Motion 写动画时必须读它。 */
  export function useMotionLevel(): MotionLevel
  /** 按档位缩放一个时长/位移。`off` 档返回 0。 */
  export function motionScale(level: MotionLevel, value: number): number
}
