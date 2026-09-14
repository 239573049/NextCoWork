/**
 * GitHub 式的 Token 活动热力图。
 *
 * **手写 CSS Grid,不用 recharts** —— recharts 没有日历热力图,拿 ScatterChart
 * 拼一个需要自己算像素坐标、自己画月份轴,比 53×7 个 div 复杂得多,而且缩放时
 * 更容易出错。
 *
 * 网格与着色全在 `usage-overview.ts` 里算好(那边有测试),这里只负责画。
 */
import { useState } from 'react'
import { useI18n } from '../../../../i18n'
import { formatCompactNumber, formatDayLong, formatNumber } from '../usage-format'
import type { HeatCell, HeatmapGrid } from '../usage-overview'
import { heatColor } from './colors'

/** 只标周一/周三/周五,和 GitHub 一样 —— 七行全标会挤。 */
const WEEKDAY_ROWS: { row: number; key: 'mon' | 'wed' | 'fri' }[] = [
  { row: 1, key: 'mon' },
  { row: 3, key: 'wed' },
  { row: 5, key: 'fri' }
]

export function ActivityHeatmap({ grid }: { grid: HeatmapGrid }): React.ReactNode {
  const { t, locale } = useI18n()
  const [hover, setHover] = useState<HeatCell | null>(null)

  return (
    <div className="min-w-0">
      <div className="flex items-start gap-1.5">
        {/* 星期标签列。★ 与网格共用同一套行高,否则标签会和方块错行 */}
        <div className="grid shrink-0 grid-rows-7 gap-[3px] pt-[15px] text-[9px] text-fg-faint">
          {Array.from({ length: 7 }, (_, row) => {
            const label = WEEKDAY_ROWS.find((item) => item.row === row)
            return (
              <span key={row} className="flex h-[11px] items-center leading-none">
                {label === undefined ? '' : t(`usage.activity.weekday.${label.key}` as never)}
              </span>
            )
          })}
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto pb-1">
          <div className="w-max">
            {/* 月份轴。列号 → 网格列,空列用占位 span 撑开 */}
            <div
              className="mb-1 grid h-3 gap-[3px] text-[9px] text-fg-faint"
              style={{ gridTemplateColumns: `repeat(${grid.weeks.length}, 11px)` }}
            >
              {grid.months.map((month) => (
                <span
                  key={month.day}
                  className="whitespace-nowrap"
                  style={{ gridColumnStart: month.weekIndex + 1 }}
                >
                  {new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(
                    new Date(`${month.day}T00:00:00Z`)
                  )}
                </span>
              ))}
            </div>

            <div
              className="grid grid-flow-col gap-[3px]"
              style={{ gridTemplateRows: 'repeat(7, 11px)' }}
              role="img"
              aria-label={t('usage.activity.summary', {
                days: formatNumber(grid.activeDays, locale)
              })}
            >
              {grid.weeks.map((column, weekIndex) =>
                column.map((cell, dayIndex) =>
                  cell === null ? (
                    // 今天之后的格子:留白而不是画成「零活动」
                    <span key={`${weekIndex}-${dayIndex}`} className="size-[11px]" />
                  ) : (
                    <span
                      key={cell.day}
                      className="size-[11px] rounded-[2px] transition-transform hover:scale-125"
                      style={{ backgroundColor: heatColor(cell.level) }}
                      onMouseEnter={() => setHover(cell)}
                      onMouseLeave={() => setHover(null)}
                      title={`${formatDayLong(cell.day, locale)} · ${
                        cell.tokens === 0
                          ? t('usage.activity.none')
                          : t('usage.activity.tooltip', {
                              tokens: formatCompactNumber(cell.tokens, locale),
                              turns: formatNumber(cell.requests, locale)
                            })
                      }`}
                    />
                  )
                )
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-fg-faint">
        {/* 悬停详情固定占一行,不做浮层 —— 浮层在 53 列的横向滚动容器里会被裁掉 */}
        <span className="min-h-[14px] truncate text-fg-muted">
          {hover === null
            ? t('usage.activity.summary', { days: formatNumber(grid.activeDays, locale) })
            : `${formatDayLong(hover.day, locale)} · ${
                hover.tokens === 0
                  ? t('usage.activity.none')
                  : t('usage.activity.tooltip', {
                      tokens: formatCompactNumber(hover.tokens, locale),
                      turns: formatNumber(hover.requests, locale)
                    })
              }`}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {t('usage.activity.less')}
          {([0, 1, 2, 3, 4] as const).map((level) => (
            <span
              key={level}
              className="size-[10px] rounded-[2px]"
              style={{ backgroundColor: heatColor(level) }}
            />
          ))}
          {t('usage.activity.more')}
        </span>
      </div>
    </div>
  )
}
