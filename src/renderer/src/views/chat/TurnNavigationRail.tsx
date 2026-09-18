/**
 * 对话流左侧的回合导航轨。
 *
 * 刻度只投影已经渲染的用户回合；正文仍是唯一内容源。滚动时以视口中心最近的
 * 回合为当前项，点击则直接移动原滚动容器，不复制消息状态。
 *
 * ★ 预览卡 portal 到 body。导航轨贴着滚动区边缘，如果把卡片放在轨道内部，
 * 会被任一祖先的 overflow 裁掉，表现为最上面和最下面几轮只能看到半张卡。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { motionScale, useMotionLevel } from '../../theme/useMotionLevel'
import { useI18n } from '../../i18n'
import type { TurnNavigationItem } from './turn-navigation'

const EDGE_THRESHOLD = 56
const PREVIEW_GAP = 8
const PREVIEW_EDGE = 12
/** 回合少时每个刻度占的行距，轨道按这个间距自然收缩。 */
const ITEM_PITCH = 14
/** 轨道总高上限：回合多了也只占视口中段一小条，不跟着铺满整列。 */
const MAX_RAIL_HEIGHT = 320

function turnTargets(content: HTMLDivElement): Map<string, HTMLElement> {
  const targets = new Map<string, HTMLElement>()
  for (const element of content.querySelectorAll<HTMLElement>('[data-turn-navigation-id]')) {
    const id = element.dataset['turnNavigationId']
    if (id !== undefined) targets.set(id, element)
  }
  return targets
}

type TurnCenter = { id: string; center: number }

function nearestTurnId(centers: readonly TurnCenter[], target: number): string {
  let low = 0
  let high = centers.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((centers[middle]?.center ?? Number.POSITIVE_INFINITY) < target) low = middle + 1
    else high = middle
  }
  const after = centers[low]
  const before = centers[low - 1]
  if (before === undefined) return after?.id ?? ''
  if (after === undefined) return before.id
  return target - before.center <= after.center - target ? before.id : after.id
}

function TurnPreview({
  id,
  anchor,
  item
}: {
  id: string
  anchor: HTMLElement
  item: TurnNavigationItem
}): ReactNode {
  const cardRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const place = (): void => {
      const card = cardRef.current
      if (card === null) return
      const anchorRect = anchor.getBoundingClientRect()
      const cardRect = card.getBoundingClientRect()
      const left = Math.min(
        anchorRect.right + PREVIEW_GAP,
        window.innerWidth - cardRect.width - PREVIEW_EDGE
      )
      const idealTop = anchorRect.top + anchorRect.height / 2 - cardRect.height / 2
      const top = Math.max(
        PREVIEW_EDGE,
        Math.min(idealTop, window.innerHeight - cardRect.height - PREVIEW_EDGE)
      )
      setPosition({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, item])

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role="tooltip"
      data-testid="turn-navigation-preview"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        visibility: position === null ? 'hidden' : 'visible'
      }}
      className="pointer-events-none fixed z-[150] w-64 max-w-[calc(100vw-48px)] rounded-card border border-stroke bg-surface-raised px-3 py-2.5 text-left shadow-xl"
    >
      <p className="line-clamp-2 text-[12px] font-medium leading-[1.45] text-fg">{item.label}</p>
      {item.description !== undefined && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-[1.45] text-fg-muted">{item.description}</p>
      )}
    </div>,
    document.body
  )
}

export function TurnNavigationRail({
  items,
  viewportRef,
  contentRef
}: {
  /** 每项对应一条用户消息引出的完整对话轮次。 */
  items: readonly TurnNavigationItem[]
  /** 复用 Thread 的滚动容器，避免导航轨拥有第二份滚动状态。 */
  viewportRef: RefObject<HTMLDivElement | null>
  /** 用于找到每个带 data-turn-navigation-id 的真实回合节点。 */
  contentRef: RefObject<HTMLDivElement | null>
}): ReactNode {
  const { t } = useI18n()
  const motionLevel = useMotionLevel()
  const tooltipId = `turn-navigation-preview-${useId()}`
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const targetsRef = useRef(new Map<string, HTMLElement>())
  const centersRef = useRef<TurnCenter[]>([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const [visible, setVisible] = useState(false)
  const [activeId, setActiveId] = useState(items[0]?.id ?? '')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const updateActiveItem = useCallback((): void => {
    const viewport = viewportRef.current
    const currentItems = itemsRef.current
    if (viewport === null) return

    const overflowing = currentItems.length > 1 && viewport.scrollHeight > viewport.clientHeight + 1
    setVisible(overflowing)
    if (!overflowing) return

    if (viewport.scrollTop <= EDGE_THRESHOLD) {
      const firstId = currentItems[0]?.id ?? ''
      setActiveId((current) => current === firstId ? current : firstId)
      return
    }
    const distanceFromEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (distanceFromEnd <= EDGE_THRESHOLD) {
      const lastId = currentItems.at(-1)?.id ?? ''
      setActiveId((current) => current === lastId ? current : lastId)
      return
    }

    const nearestId = nearestTurnId(
      centersRef.current,
      viewport.scrollTop + viewport.clientHeight / 2
    )
    if (nearestId !== '') setActiveId((current) => current === nearestId ? current : nearestId)
  }, [viewportRef])

  const syncTargets = useCallback((): void => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (viewport === null || content === null) return
    const targets = turnTargets(content)
    const viewportRect = viewport.getBoundingClientRect()
    targetsRef.current = targets
    centersRef.current = itemsRef.current.flatMap((item) => {
      const target = targets.get(item.id)
      if (target === undefined) return []
      const rect = target.getBoundingClientRect()
      return [{
        id: item.id,
        center: viewport.scrollTop + rect.top - viewportRect.top + rect.height / 2
      }]
    })
    updateActiveItem()
  }, [contentRef, updateActiveItem, viewportRef])

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (viewport === null || content === null) return
    /*
      ★ scroll 热路径只查缓存后的数字，不能在每个事件里 querySelectorAll 再逐轮
      getBoundingClientRect。长会话有几百轮，那会把一次滚动变成几百次布局读取。
      回合几何只在内容或视口尺寸变化时重建。
    */
    viewport.addEventListener('scroll', updateActiveItem, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncTargets)
    observer?.observe(viewport)
    observer?.observe(content)
    syncTargets()
    return () => {
      viewport.removeEventListener('scroll', updateActiveItem)
      observer?.disconnect()
    }
  }, [contentRef, syncTargets, updateActiveItem, viewportRef])

  useLayoutEffect(() => {
    syncTargets()
  }, [items, syncTargets])

  const scrollToItem = useCallback((item: TurnNavigationItem, index: number): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const target = targetsRef.current.get(item.id)
    if (target === undefined) return

    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const targetRect = target.getBoundingClientRect()
    const targetTop = index === itemsRef.current.length - 1
      ? maximum
      : viewport.scrollTop + targetRect.top
        - viewport.getBoundingClientRect().top
        - (viewport.clientHeight - targetRect.height) / 2
    const top = Math.max(0, Math.min(targetTop, maximum))
    const behavior: ScrollBehavior = motionScale(motionLevel) === 0 ? 'auto' : 'smooth'
    setActiveId(item.id)
    if (typeof viewport.scrollTo === 'function') viewport.scrollTo({ top, behavior })
    else viewport.scrollTop = top
  }, [motionLevel, viewportRef])

  if (!visible) return null

  const previewId = hoveredId ?? focusedId
  const previewItem = items.find((item) => item.id === previewId)
  const previewAnchor = previewId === null ? undefined : itemRefs.current.get(previewId)
  const highlightedId = previewId ?? activeId
  const highlightedIndex = items.findIndex((item) => item.id === highlightedId)

  return (
    <div className="pointer-events-none absolute inset-y-3 left-2 z-10 flex w-7 items-center" data-testid="turn-navigation">
      <nav
        aria-label={t('chat.navigation.label')}
        className="pointer-events-auto grid max-h-full w-full translate-y-[12%] content-center py-1"
        /*
          ★ 行高用 1fr 均分而不是 minmax(2px, 14px)：封顶之后固定的最小行高会让
          几十轮的刻度撑出容器，反而比封顶前更长。高度先按回合数算，再被
          MAX_RAIL_HEIGHT 和 max-h-full 两道上限夹住，行距自己摊。

          ★ translate 那一下是配平视觉重心：定位父级只到滚动区为止，而任务清单、
          队列、目标行是滚动区外面的兄弟节点，压在下面。严格居中在滚动区里，
          看上去就偏高了。
        */
        style={{
          height: Math.min(items.length * ITEM_PITCH, MAX_RAIL_HEIGHT),
          gridTemplateRows: `repeat(${items.length}, minmax(0, 1fr))`
        }}
      >
        {items.map((item, index) => {
          const selected = item.id === activeId
          const distance = highlightedIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - highlightedIndex)
          const width = distance === 0 ? 16 : distance === 1 ? 11 : distance === 2 ? 7 : 4
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node === null) itemRefs.current.delete(item.id)
                else itemRefs.current.set(item.id, node)
              }}
              type="button"
              aria-current={selected ? 'location' : undefined}
              aria-describedby={previewId === item.id ? tooltipId : undefined}
              aria-label={t('chat.navigation.item', {
                index: index + 1,
                total: items.length,
                title: item.label
              })}
              data-testid="turn-navigation-item"
              onPointerEnter={() => setHoveredId(item.id)}
              onPointerLeave={() => setHoveredId((current) => current === item.id ? null : current)}
              onFocus={() => setFocusedId(item.id)}
              onBlur={() => setFocusedId((current) => current === item.id ? null : current)}
              onClick={() => scrollToItem(item, index)}
              className="app-no-drag flex min-h-0 w-7 items-center justify-start rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <span
                aria-hidden="true"
                style={{ width }}
                className={cn(
                  'block h-px origin-left rounded-pill transition-[width,opacity,background-color] duration-150 motion-reduce:transition-none',
                  item.id === highlightedId
                    ? 'bg-fg opacity-100'
                    : selected
                      ? 'bg-fg-muted opacity-90'
                      : 'bg-fg-faint opacity-60'
                )}
              />
            </button>
          )
        })}
      </nav>
      {previewItem !== undefined && previewAnchor !== undefined && (
        <TurnPreview id={tooltipId} anchor={previewAnchor} item={previewItem} />
      )}
    </div>
  )
}
