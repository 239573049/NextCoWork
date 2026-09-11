/**
 * 图标表 —— 侧边栏导航项、功能 Tab、内层 Tab 三处引用同一份。
 *
 * 单独一个文件是因为**导航项和功能 Tab 必须共用同一个图标**:截图 4aa68110 里,
 * 「定时任务」的功能 Tab 打开时,侧边栏对应的那一项是高亮的 —— 两处是同一个东西的
 * 两个位置。图标各写各的话,总有一天会漂移成两个不同的图标。
 */
import {
  Blocks,
  ChartNoAxesCombined,
  ClockFading,
  Earth,
  Files,
  Image as ImageIcon,
  MessageSquare,
  PenTool,
  Settings,
  SquareTerminal,
  FileText,
  type LucideIcon
} from 'lucide-react'
import type { FeatureKind, InnerTabKind } from '../../../shared/domain/tab'

/**
 * ★ 这四个字形是**对着截图放大 6~16 倍、再比对 lucide 的真实 path 数据挑的**,
 * 不是按名字猜的:
 * 「定时任务」表盘上有缺口(`ClockFading`),不是完整一圈的 `Clock`;
 * 「扩展」的 `Blocks` 是**新挑的,没有参考图可比** —— 这一格原本是「Skill 管理」,
 *   用的是带横线的卷轴(`ScrollText`);现在它扩成了技能 / 命令 / 子代理 / 钩子
 *   四类资源的统一入口,而卷轴只说得了 Skill 一件事。有了设计稿该回来重挑。
 * 「浏览器」是带大陆块的地球(`Earth`)不是经纬线球(`Globe`)——
 *   参考图那个是地球+光标,lucide 全套(earth / globe / globe-2 / …)都没有,`Earth` 是最近的;
 * 「每日回顾」是柱子加一条趋势线(`ChartNoAxesCombined`)不是打勾的日历。
 * 换回去之前先去比一眼 docs/images 与 docs/image-new 里的原图。
 */
export const FEATURE_ICON: Record<FeatureKind, LucideIcon> = {
  scheduled: ClockFading,
  extensions: Blocks,
  browser: Earth,
  review: ChartNoAxesCombined,
  settings: Settings
}

export const INNER_TAB_ICON: Record<InnerTabKind, LucideIcon> = {
  chat: MessageSquare,
  terminal: SquareTerminal,
  doc: FileText,
  draw: PenTool,
  browser: Earth,
  /*
    ⚠️ 这一个是**待核对的猜测**,不像上面那批是比对过 path 数据的。
    截图里「文件预览」的字形是一个圆角方框里带一道斜线/山形,`Image` 最接近
    (圆角矩形 + 小圆点 + 山形对角线)。等拿到更大的原图再确认一次。
    别名导入是因为 `Image` 和 DOM 的全局 `Image` 构造器重名。
  */
  preview: ImageIcon,
  /*
    参考里「工作区文件」那个 Tab 的字形是**带横线的单张文档**,也就是 `FileText`——
    但 `doc` 已经占了它,同一条 Tab 条上两种 kind 同图标就白画了。
    退一格用叠起来的 `Files`:它同样是"文档"语义,又能和单个文档区分开。
    **这是有意偏离参考的一处**,不是没看图。
  */
  files: Files
}
