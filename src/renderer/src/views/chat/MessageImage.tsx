/**
 * 转录里的图片 —— 已经发出去的那些。
 *
 * ## 三种 dataRef,只有一种能直接显示
 *
 * - **`ncw://`**(本应用上传的)→ 协议直供,`<img>` 拿到就能画。
 * - **绝对路径**(Agent 产出的图、从别处引用的)→ **画不出来**。
 *   渲染层不能加载 `file://`(那要关掉 `webSecurity`,等于拆掉整个沙箱),
 *   所以只能显示一个带路径的占位。这不是缺陷,是安全边界的必然结果 ——
 *   要让它们也能显示,正确做法是把它们也纳入附件管理,而不是放开 file://。
 * - **失效的引用**(文件被删、转录从别的机器导入)→ 协议回 404,
 *   走 `onError` 显示占位。
 *
 * ## 为什么不做灯箱
 *
 * 点击放大需要一层 modal、焦点管理、Esc 关闭、多图翻页。那是一个独立的
 * 组件,而这里先把「图能看见」这件事做对。点击暂时走系统默认查看器。
 */
import { ImageOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { NCW_SCHEME } from '../../../../shared/domain/attachment'
import { cn } from '../../lib/cn'

export function MessageImage({
  mime,
  dataRef
}: {
  mime: string
  dataRef: string
}): ReactNode {
  const [failed, setFailed] = useState(false)
  const displayable = dataRef.startsWith(`${NCW_SCHEME}://`)

  if (!displayable) {
    // 外部绝对路径:显示文件名而不是整条路径 —— 路径可能很长,
    // 而用户真正需要辨认的是「哪一张图」。
    return <ImagePlaceholder label={fileNameOf(dataRef)} hint="外部文件" />
  }

  if (failed) {
    return <ImagePlaceholder label="图片已不存在" hint={mime} />
  }

  return (
    <img
      src={dataRef}
      alt=""
      data-testid="message-image"
      loading="lazy"
      onError={() => { setFailed(true) }}
      /*
        ★ 尺寸上限是必须的:一张 4000px 宽的截图会把消息气泡撑破,
        而 `max-w-full` 只管宽度 —— 竖长图仍会占满整屏往下推。
        两个方向都要限,`object-contain` 保证不变形。
      */
      className="my-1 max-h-[320px] max-w-full cursor-zoom-in rounded-card border border-border object-contain"
      onClick={() => { window.open(dataRef, '_blank') }}
    />
  )
}

function ImagePlaceholder({ label, hint }: { label: string; hint: string }): ReactNode {
  return (
    <div
      data-testid="message-image-placeholder"
      className={cn(
        'my-1 inline-flex items-center gap-2 rounded-card border border-border',
        'bg-tint/50 px-2.5 py-2 text-[12px] text-fg-faint'
      )}
    >
      <ImageOff size={14} className="shrink-0" />
      <span className="max-w-[240px] truncate">{label}</span>
      <span className="shrink-0 text-fg-faint/70">{hint}</span>
    </div>
  )
}

function fileNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? path : path.slice(i + 1)
}
