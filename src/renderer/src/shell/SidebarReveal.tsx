/**
 * 独立页面左上角那颗「展开侧边栏」,外加 macOS 红绿灯的让位。
 *
 * ★ **为什么需要它。** 独立 feature 页(Git / 扩展 / 浏览器 / 定时任务)把外层那条
 *   34px Tab 条**整条换掉**了 —— 见 `AppShell.tsx` 里 `activeStandaloneFeature`
 *   的分支。而展开按钮和红绿灯的让位偏偏都长在那条上,于是这四个页面在侧边栏
 *   收起态下:既没有任何办法把侧边栏叫回来(收起按钮在侧边栏自己身上,而它已经
 *   宽度为 0 了),标题还压在三颗红绿灯底下。
 *
 * ★ **做成共用件而不是各页各写一份。** 四个页面的这块逻辑逐字相同,而尺寸
 *   (28×38 药丸、78px 的让位)是量出来的 —— 复制四份就等于四份各自漂移。
 *
 * 那些数的来历全在 `AppShell.tsx` 里那段长注释上,改之前先读它。这里只解释差值:
 * 那边是 `pl-[78px]` 直接改内边距(Tab 条本身 `px-2`),这里的宿主是 feature 页
 * 统一的 `px-4`,所以让位改成一个 62px 的占位盒 —— 16 + 62 = 78,落点一致。
 */
import { PanelLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '../components/ui/IconButton'
import { useI18n } from '../i18n'
import { IS_MAC } from '../lib/platform'
import { useWindowStore } from '../stores/window'

export function SidebarReveal(): ReactNode {
  const { t } = useI18n()
  const collapsed = useWindowStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useWindowStore((state) => state.toggleSidebar)
  if (!collapsed) return null
  return (
    <>
      {/*
        红绿灯是系统画的,浮在窗口左上角、**不占任何元素的流** —— 所以只能实打实
        地让出宽度。非 mac 上左上角是空的(按钮在右上角,见 WindowControls),
        留这块就是个空洞。
      */}
      {IS_MAC && <span aria-hidden className="w-[62px] shrink-0" />}
      <IconButton
        label={t('nav.expandSidebar')}
        size={28}
        width={38}
        // `active` 不是可选项:它在报告「侧边栏现在是收起的」,同 AppShell 那颗
        active
        onClick={toggleSidebar}
        // reveal-delayed:等侧边栏收完再淡入,否则会和侧边栏里那颗「收起」
        // 同屏出现 280ms —— 它俩是同一个控件的两个位置
        className="reveal-delayed shrink-0 rounded-pill"
      >
        <PanelLeft size={16} strokeWidth={1.5} />
      </IconButton>
    </>
  )
}
