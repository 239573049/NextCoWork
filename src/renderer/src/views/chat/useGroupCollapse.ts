/**
 * 折叠意图的归属 —— 设计文档 §5.4。
 *
 * ★ **裁决:用户一旦手动操作某个组,该组永久脱离自动规则,直到组件卸载。**
 *
 * 反过来的设计(自动规则始终有效、手动只是临时覆盖)在真实使用里是这样的:
 * 用户展开一个早期组去读命令输出,run 还在继续,新工具不断到达 ——
 * 自动规则于是把它重新合上,**在用户正读到一半的时候**。
 * 「界面跟我抢控制权」的代价,远大于「用户展开了几组导致页面有点长」。
 *
 * 反向同样成立:用户主动收起最近一组后,不该因为又来一个新工具就被重新展开。
 */
import { useCallback, useState } from 'react'

export interface GroupCollapse {
  collapsed: boolean
  toggle: () => void
  /** 用户是否表过态 —— 组标题上可以据此显示一个「已锁定」的弱提示 */
  pinned: boolean
}

export function useGroupCollapse(autoCollapsed: boolean, hasError: boolean): GroupCollapse {
  /** `null` = 从未手动操作,跟随自动规则 */
  const [userToggled, setUserToggled] = useState<boolean | null>(null)

  // 失败组的自动态永远是「展开」,它优先于窗口算出来的结果
  const auto = hasError ? false : autoCollapsed
  const collapsed = userToggled ?? auto

  const toggle = useCallback(() => {
    setUserToggled((v) => !(v ?? auto))
  }, [auto])

  return { collapsed, toggle, pinned: userToggled !== null }
}
