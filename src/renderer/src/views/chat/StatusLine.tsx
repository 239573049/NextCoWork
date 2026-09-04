/**
 * 输入框上方那行状态 —— 截图:`生成中 · 7s · ↓93`,外加上下文压力条。
 *
 * ★ **这里同时是 e2e 探针的读取点。** 属性是机器可读的
 * (`data-status` / `data-seq` / `data-model`),不是给人看的那句中文 ——
 * 探针去正则一句会随文案改动的话,产品界面就得永远背着一个调试字符串,
 * 而且改文案会莫名其妙挂掉 e2e。
 *
 * 三样数据都是已有事件的直接投影(方案 §8):`message_start.model`、
 * `TokenUsage`、`context_usage`。不新增任何数据。
 */
import type { ReactNode } from 'react'
import type { RunStatus } from '../../../../shared/agent/event'
import type { TranscriptState } from '../../../../shared/agent/transcript'
import { hasRun } from '../../../../shared/agent/transcript'
import { cn } from '../../lib/cn'

const STATUS_LABEL: Record<RunStatus, string> = {
  running: '生成中',
  done: '已完成',
  error: '出错',
  aborted: '已停止'
}

/**
 * 压力条**平时根本不画**,过半才出现,逼近上限才变色。
 *
 * ★ 原本是「一直画着、只是不变色」,截图里那就是状态行最右边一根**孤零零的短横线** ——
 * 没有标签、没有数字、填充几乎为零,看着完全像个渲染残留,而不像一个刻意的读数。
 * 一个 3px 高、无标注的条只有在**读数本身值得看**的时候才传递信息;
 * 用了 4% 的上下文不值得看。
 */
const PRESSURE_SHOW = 0.5
const PRESSURE_WARN = 0.75

export function StatusLine({
  transcript,
  running,
  lastSeq,
  queued
}: {
  transcript: TranscriptState
  running: boolean
  lastSeq: number
  queued: number
}): ReactNode {
  const { status, model, usage, contextUsage } = transcript
  // 还没发过消息的空会话没有「状态」可言 —— 参考实现在这一屏是一句问候加输入框,
  // 输入框上方什么都没有(截图 c6184031)。见 `hasRun` 说明为什么不能只看 status。
  if (!hasRun(transcript, running)) return null

  const ratio =
    contextUsage === undefined || contextUsage.window === 0
      ? 0
      : Math.min(1, contextUsage.used / contextUsage.window)

  return (
    <div
      data-testid="chat-status"
      data-status={status}
      data-seq={lastSeq}
      data-model={model ?? ''}
      data-queued={queued}
      className="mx-auto flex w-full max-w-[760px] shrink-0 items-center gap-2 px-6 pb-1.5 text-[11.5px] text-fg-faint"
    >
      <span className={cn(running && 'text-accent')}>{STATUS_LABEL[status]}</span>

      {usage !== undefined && (
        <>
          <Dot />
          <span title={`输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}`}>
            ↓{usage.outputTokens}
          </span>
        </>
      )}

      {queued > 0 && (
        <>
          <Dot />
          <span>队列 {queued}</span>
        </>
      )}

      <div className="flex-1" />

      {contextUsage !== undefined && (ratio >= PRESSURE_SHOW || contextUsage.shouldCompact) && (
        <div
          className="flex items-center gap-1.5"
          title={`上下文 ${contextUsage.used} / ${contextUsage.window}`}
        >
          {contextUsage.shouldCompact && (
            // 上下文用尽是这类应用最高频的失败(方案 §4.2)。逼近上限时
            // 明说该怎么办,而不是等它 400 之后再报一个 context_length。
            <span className="text-accent">接近上限,可 /compact</span>
          )}
          <div className="h-[3px] w-16 overflow-hidden rounded-pill bg-tint">
            <div
              className={cn(
                'h-full rounded-pill transition-[width]',
                ratio >= PRESSURE_WARN ? 'bg-accent' : 'bg-fg-faint'
              )}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Dot(): ReactNode {
  return <span aria-hidden className="text-fg-faint/50">·</span>
}
