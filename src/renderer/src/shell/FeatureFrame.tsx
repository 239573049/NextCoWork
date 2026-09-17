/**
 * 独立 feature 页的统一外壳 —— 52px 标题栏 + 画布。
 *
 * ## 为什么要有这个文件
 *
 * Git / 扩展 / 浏览器 / 技能四个页面**各手写了一份**同一套东西:一个
 * `flex min-h-0 flex-1 flex-col bg-canvas` 的外框、一条
 * `app-drag flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-4`
 * 的标题栏、非 mac 上的 `pr-window-controls` 让位、外加一个 `SidebarReveal`。
 * 四份逐字相同的类名串,改一处漏三处 —— 而漏掉的那几处不会报错,只会在某一页上
 * 「标题压在红绿灯底下」或者「这一页拖不动窗口」。`shell/SidebarReveal.tsx`
 * 已经为同一个原因抽过一次了,这是它的下一层。
 *
 * ## 这里替调用方管住的三件事
 *
 * 1. **`app-drag` 的边界。** 这条 52px **替换掉了**外层那条 34px Tab 条
 *    (见 `AppShell` 的 `activeStandaloneFeature` 分支),窗口顶部唯一能拖的
 *    地方就剩它。而 `-webkit-app-region` 是**继承**属性 —— `shell/Dock.tsx`
 *    记过一次真实事故:给一栏挂 `app-no-drag`,滚动长内容的包围盒把整块 drag 区
 *    减掉了。所以可交互控件要自带 `app-no-drag`(`IconButton` 之类已经带了)。
 * 2. **右端让位。** 自绘的三颗窗口按钮是 **fixed 悬浮层**,不占顶栏的流,
 *    只能实打实让出宽度(`pr-window-controls`,见 `styles/theme.css`)。
 *    左端红绿灯的让位在 `SidebarReveal` 里。
 * 3. **z 轴留在 0 档。** 这一层不设 `z-*`(`styles/theme.css` 只有 5 档),
 *    页面内容永远压不过宿主的菜单与模态。
 *
 * ## 给插件视图预留的那一层
 *
 * P3 的插件视图会复用这个外壳(计划 §9.2):插件拿到的是 `children` 那一格,
 * 标题栏由宿主画。**先抽出来再开放**,否则每个插件各写一份 52px 标题栏,
 * 然后各自漂移 —— 那正是这个文件在收拾的局面。
 */
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { IS_MAC } from '../lib/platform'
import { SidebarReveal } from './SidebarReveal'

/** 四个页面逐字相同的那一串。改它等于同时改四个页面,这是故意的。 */
const HEADER_CLASS =
  'app-drag flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-4'

export interface FeatureFrameProps {
  /**
   * 标题栏的内容(`SidebarReveal` 之后)。右端那组按钮由调用方自己用
   * `ml-auto` 推过去 —— 四个页面的右端差别很大(有的空、有的三颗按钮),
   * 参数化只会变成一堆互不相干的条件渲染。
   */
  header: ReactNode
  /**
   * 收起态下的展开按钮与 macOS 红绿灯让位。
   *
   * 嵌在别的 feature 里时关掉(此时外层那一条已经有了),独立成页时必须开 ——
   * 关掉的代价是侧边栏收起后**没有任何办法把它叫回来**。
   */
  reveal?: boolean
  /**
   * 右端是否给自绘窗口按钮让位。嵌套渲染时关掉:那三颗按钮是外层那条的事。
   */
  windowControls?: boolean
  /** 标题栏下面那一整格。自己决定是 `flex-col` 还是左右分栏。 */
  children: ReactNode
}

export function FeatureFrame({
  header,
  reveal = true,
  windowControls = true,
  children
}: FeatureFrameProps): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className={cn(HEADER_CLASS, windowControls && !IS_MAC && 'pr-window-controls')}>
        {reveal && <SidebarReveal />}
        {header}
      </header>
      {children}
    </div>
  )
}
