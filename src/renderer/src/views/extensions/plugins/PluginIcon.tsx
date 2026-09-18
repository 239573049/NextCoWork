import { Puzzle } from 'lucide-react'
import { useState, type ReactNode } from 'react'

/**
 * 市场条目的图标。
 *
 * ★ 远端图片**必须留兜底**:图挂了的话 `<img>` 会退化成一个破图标记,
 * 那比没有图标更像「这个插件有问题」。`onError` 之后换回 Puzzle。
 */
export function PluginIcon({ iconUrl, size = 44 }: { iconUrl: string | null; size?: number }): ReactNode {
  const [failed, setFailed] = useState(false)
  return (
    <div
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-[12px] border border-hairline bg-tint text-fg-faint"
    >
      {iconUrl !== null && iconUrl !== '' && !failed ? (
        <img
          src={iconUrl}
          alt=""
          style={{ width: size * 0.64, height: size * 0.64 }}
          className="rounded-[8px] object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Puzzle size={Math.round(size * 0.45)} />
      )}
    </div>
  )
}
