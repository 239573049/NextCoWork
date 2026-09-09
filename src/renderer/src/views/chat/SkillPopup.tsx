import { AlertTriangle, Search, Sparkles } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import type { SkillListItem } from '../../../../shared/domain/skill'
import { cn } from '../../lib/cn'

export function SkillPopup({ id, items, active, loading, error, search, onSearch, onPick, onHover, onKeyDown, labels }: {
  id: string; items: SkillListItem[]; active: number; loading: boolean; error: boolean; search?: string
  onSearch: (value: string) => void; onPick: (skill: SkillListItem) => void; onHover: (index: number) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => boolean; labels: { search: string; loading: string; error: string; empty: string }
}): ReactNode {
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (search !== undefined) searchRef.current?.focus() }, [search])
  return (
    <div className="absolute bottom-full left-2 z-20 mb-2 w-[min(380px,calc(100%-1rem))] overflow-hidden rounded-xl border border-border bg-surface-input p-1 shadow-lg" onKeyDown={onKeyDown}>
      {search !== undefined && <div className="flex items-center gap-2 border-b border-border px-2 py-1.5"><Search size={14} className="text-fg-faint" /><input ref={searchRef} value={search} onChange={(e) => onSearch(e.target.value)} placeholder={labels.search} aria-label={labels.search} className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none" /></div>}
      <div id={id} role="listbox" className="max-h-64 overflow-y-auto py-1">
        {loading ? <div className="px-3 py-4 text-center text-[12px] text-fg-faint">{labels.loading}</div> : error ? <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-danger"><AlertTriangle size={14} />{labels.error}</div> : items.length === 0 ? <div className="px-3 py-4 text-center text-[12px] text-fg-faint">{labels.empty}</div> : items.map((skill, i) => (
          <button key={skill.id} id={`${id}-${i}`} type="button" role="option" aria-selected={i === active} className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left', i === active && 'bg-tint')} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => onHover(i)} onClick={() => onPick(skill)}>
            <Sparkles size={14} className="mt-0.5 shrink-0 text-accent" /><span className="min-w-0"><span className="block truncate text-[12px] text-fg">{skill.name}</span><span className="block truncate text-[11px] text-fg-faint">{skill.description}</span></span>
          </button>
        ))}
      </div>
    </div>
  )
}
