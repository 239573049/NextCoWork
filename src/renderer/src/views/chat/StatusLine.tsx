/**
 * 本轮助手回复下方的执行状态、用量与上下文压力条。
 *
 * ★ **这里同时是 e2e 探针的读取点。** 属性是机器可读的
 * (`data-status` / `data-seq` / `data-model`),不是给人看的那句中文 ——
 * 探针去正则一句会随文案改动的话,产品界面就得永远背着一个调试字符串,
 * 而且改文案会莫名其妙挂掉 e2e。
 *
 * 三样数据都是已有事件的直接投影(方案 §8):`message_start.model`、
 * `TokenUsage`、`context_usage`。不新增任何数据。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { TranscriptState } from '../../../../shared/agent/transcript'
import { hasRun } from '../../../../shared/agent/transcript'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { whimsyEn, whimsyZh } from '../../i18n/agent'
import type { Locale } from '../../i18n'

/**
 * 4 秒:比读完一个词慢得多,又比「一直不动」快得多。
 * 再快就成了跑马灯,眼睛会一直被它拽过去 —— 而这里全部的信息量就是「还活着」。
 */
const WHIMSY_ROTATE_MS = 4000

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
  waitingForResponse,
  lastSeq,
  queued
}: {
  transcript: TranscriptState
  running: boolean
  waitingForResponse: boolean
  lastSeq: number
  queued: number
}): ReactNode {
  const { t, locale } = useI18n()
  const { status, model, usage, contextUsage, notice } = transcript
  // ★ 在 early return 之前调用 —— hooks 不能出现在条件分支后面。
  const whimsy = useWhimsy(waitingForResponse, locale)
  // 还没发过消息的空会话没有「状态」可言 —— 参考实现在这一屏是一句问候加输入框,
  // 输入框上方什么都没有(截图 c6184031)。见 `hasRun` 说明为什么不能只看 status。
  if (!hasRun(transcript, running)) return null

  /*
    ★ 重试 / 切换提示**压过**那句「正在等待回复…」,而不是并排再加一行:
    两者说的是同一件事的两个层次,并排会让状态行在退避期间抖动。
    ★ 只换这一句人读的文案,`data-status` 一个字节不动 —— 探针读的是属性,
    见本文件抬头那段。
  */
  const noticeText = notice === undefined
    ? undefined
    : notice.kind === 'retry'
      ? t('chat.status.retrying', { attempt: notice.attempt, reason: notice.reason })
      : t('chat.status.providerSwitched', { to: notice.to, reason: notice.reason })

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
      className="flex w-full items-center gap-2 text-[11.5px] text-fg-faint"
    >
      {/* ★ 有提示时用 danger 而不是运行中的绿:绿色说的是「一切正常」,而此刻不是。
          比最终错误那个红框轻一档(只有文字变色,没有边框和底色)—— 重试多半会自己好。
          色板里没有 warning 这一档,不为这一处新造一个 token。 */}
      <span role="status" className={cn('inline-flex items-center gap-1.5',
        noticeText !== undefined ? 'text-danger' : running && 'text-accent')}>
        {running && <LoaderCircle size={12} aria-hidden className="animate-spin motion-reduce:animate-none" />}
        {noticeText ?? (waitingForResponse ? (
          /*
            ★ 读屏拿到的是那句**不动**的「正在等待回复…」,轮换的词 aria-hidden。
            `role="status"` 自带 aria-live=polite:每 4 秒换一个词就是每 4 秒打断一次朗读,
            对看不见这行字的人来说,趣味词全是噪音,而它连一个字节的状态都没多说。
          */
          <>
            <span className="sr-only">{t('chat.status.waitingResponse')}</span>
            <span aria-hidden>{whimsy}</span>
          </>
        ) : t(`chat.status.${status}`))}
      </span>

      {running && usage !== undefined && (
        <>
          <Dot />
          <span title={t('chat.usageTooltip', { input: usage.inputTokens, output: usage.outputTokens })}>
            ↓{usage.outputTokens}
          </span>
        </>
      )}

      {queued > 0 && (
        <>
          <Dot />
          <span>{t('chat.queue', { count: queued })}</span>
        </>
      )}

      <div className="flex-1" />

      {contextUsage !== undefined && (ratio >= PRESSURE_SHOW || contextUsage.shouldCompact) && (
        <div
          className="flex items-center gap-1.5"
          title={t('chat.contextTooltip', { used: contextUsage.used, window: contextUsage.window })}
        >
          {contextUsage.shouldCompact && (
            // 上下文用尽是这类应用最高频的失败(方案 §4.2)。逼近上限时
            // 明说该怎么办,而不是等它 400 之后再报一个 context_length。
            <span className="text-accent">{t('chat.contextNearLimit')}</span>
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

/**
 * 等待期间轮换一个词。`active` 为假时**不起定时器**,也不推进下标 ——
 * 下一轮等待会从上一轮停住的地方接着走,而不是每次都从同一个词开始。
 */
function useWhimsy(active: boolean, locale: Locale): string {
  const words = locale === 'en-US' ? whimsyEn : whimsyZh
  // 初值随机:否则每个会话的第一句永远是同一个词,轮换就只剩下后面几秒有意思。
  const [index, setIndex] = useState(() => Math.floor(Math.random() * words.length))
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      // +1 起跳保证**一定**换一个词 —— 纯随机会挑中自己,看上去就是定时器停了。
      setIndex((prev) => (prev + 1 + Math.floor(Math.random() * (words.length - 1))) % words.length)
    }, WHIMSY_ROTATE_MS)
    return () => clearInterval(timer)
  }, [active, words.length])
  // `?? words[0]` 只是为了闭合 noUncheckedIndexedAccess:取模之后下标不可能越界。
  return words[index % words.length] ?? words[0]
}

function Dot(): ReactNode {
  return <span aria-hidden className="text-fg-faint/50">·</span>
}
