/**
 * 图片灯箱 —— 点转录里的图放大看。
 *
 * ## 为什么这值得一个组件而不是 `window.open`
 *
 * `window.open('ncw://…')` 会新开一个 Electron 窗口去加载协议 URL。它能用,
 * 但那个窗口没有我们的 CSP、没有标题、关不掉也回不去,而且多图之间没法翻页 ——
 * 用户看第二张图要先关掉再点一次。
 *
 * ## 焦点必须还回去
 *
 * 打开时把焦点移进灯箱、关闭时**还给触发它的那个元素**。不还的话焦点会掉回
 * `<body>`,键盘用户按 Tab 是从页面顶端重新开始 —— 他刚才读到哪就丢了。
 * 这不是可选的润色,是模态框的基本契约。
 *
 * ## Esc 的监听挂在 window 上,不是容器上
 *
 * 挂容器要求焦点在容器内才收得到。用户点了一下遮罩(焦点跑到 body)之后
 * 再按 Esc 就没反应 —— 一个只在特定操作顺序下复现的"有时候关不掉"。
 */
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface LightboxImage {
  mime: string
  dataRef: string
}

export function ImageLightbox({
  images,
  startIndex,
  onClose
}: {
  images: readonly LightboxImage[]
  startIndex: number
  onClose: () => void
}): ReactNode {
  const [index, setIndex] = useState(startIndex)
  const closeRef = useRef<HTMLButtonElement>(null)
  /** 打开前的焦点。关闭时要还回去 */
  const restoreRef = useRef<Element | null>(null)

  const prev = useCallback(() => {
    setIndex((i) => (i - 1 + images.length) % images.length)
  }, [images.length])

  const next = useCallback(() => {
    setIndex((i) => (i + 1) % images.length)
  }, [images.length])

  useEffect(() => {
    restoreRef.current = document.activeElement
    closeRef.current?.focus()

    // ★ 挂 window,不挂容器 —— 点过遮罩之后焦点在 body,挂容器就收不到了
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); next() }
    }
    window.addEventListener('keydown', onKey)

    // 背景不该跟着滚:灯箱是模态的,滚轮应当作用在图上而不是它下面的转录
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      // 焦点还给触发元素。它可能已经被卸载(转录重渲染),所以要判一下
      const el = restoreRef.current
      if (el instanceof HTMLElement && document.contains(el)) el.focus()
    }
  }, [onClose, prev, next])

  const current = images[index]
  if (current === undefined) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      data-testid="image-lightbox"
      // 点遮罩关闭。★ 只认落在遮罩自身上的点击 —— 冒泡上来的(点在图上)不算,
      //   否则用户想拖选图片时一松手就关了。
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/80 backdrop-blur-sm"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="关闭"
        data-testid="lightbox-close"
        className="absolute top-4 right-4 rounded-[7px] p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X size={18} />
      </button>

      {images.length > 1 && (
        <>
          <NavButton side="left" onClick={prev} />
          <NavButton side="right" onClick={next} />
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2.5 py-1 text-[12px] text-white/80">
            {index + 1} / {images.length}
          </div>
        </>
      )}

      {/*
        ★ `max-h-[90vh] max-w-[90vw]` + `object-contain`:两个方向都限。
        只限宽的话竖长图会超出视口顶底,而灯箱里没有滚动条可用。
      */}
      <img
        src={current.dataRef}
        alt=""
        data-testid="lightbox-image"
        className="max-h-[90vh] max-w-[90vw] object-contain"
      />
    </div>,
    document.body
  )
}

function NavButton({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? '上一张' : '下一张'}
      data-testid={`lightbox-${side}`}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/70 transition-colors hover:bg-black/60 hover:text-white ${
        side === 'left' ? 'left-4' : 'right-4'
      }`}
    >
      {side === 'left' ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </button>
  )
}
