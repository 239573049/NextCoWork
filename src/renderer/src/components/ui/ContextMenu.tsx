import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuPosition {
  x: number
  y: number
}

/** Pointer-positioned menu used by right-click actions inside scrollable panels. */
export function ContextMenu({
  position,
  label,
  width = 192,
  onClose,
  children
}: {
  position: ContextMenuPosition
  label: string
  width?: number
  onClose: () => void
  children: (close: () => void) => ReactNode
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const margin = 8
    setPlaced({
      left: Math.max(margin, Math.min(position.x, window.innerWidth - panel.offsetWidth - margin)),
      top: Math.max(margin, Math.min(position.y, window.innerHeight - panel.offsetHeight - margin))
    })
    panel.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [position])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!panelRef.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    const onViewportChange = (): void => onClose()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    document.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
      document.removeEventListener('scroll', onViewportChange, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        width,
        left: placed?.left ?? position.x,
        top: placed?.top ?? position.y,
        visibility: placed === null ? 'hidden' : undefined
      }}
      className="app-no-drag fixed z-50 rounded-card border border-border bg-surface-raised p-1 shadow-2xl shadow-black/35 outline-none"
    >
      {children(onClose)}
    </div>,
    document.body
  )
}
