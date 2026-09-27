/**
 * `image` 形态的详情渲染器 —— 对话内生图(`generate_image`)的**专属图片卡**。
 *
 * 需求:
 *   1. 生成过程要有自己的样子:按请求张数(`n`)摆 N 格**图片加载格**(光带扫过的
 *      相纸 + 状态字),而不是一行通用的「运行中」;
 *   2. 多张时逐张出图:哪一格先到就先换成图(`ToolCallState.partialImages`,
 *      按格子序号放),其余继续转;
 *   3. 跑完显示成品网格,点任意一张进灯箱、左右翻页。
 * 「这一刻摆什么」全部由 `image-gen-view.ts` 算,这里只负责摆。
 *
 * ★ 为什么不复用 `MessageImage`:它只画 `ncw://`(附件协议),遇到 `data:` 会
 * 退化成占位 —— 而工具产出的图恰恰全是 data URL(见 `ToolOutputImage`)。
 * 灯箱 `ImageLightbox` 对 dataRef 不挑,直接复用。
 *
 * ★ 为什么不走 `ToolCard`:图已经在 `output.images` 里(模型也要看它、`latest` 改图
 * 也要找它),再复制一份进 card 等于每张几 MB 的图在转录里存两遍。
 *
 * ★ 故意不做:不画「失败格」。失败的那几张在跑完后直接不占位,只在底部说一句
 * 「成功 3/4 张」——一格永远的叉号比少一格更像界面坏了;失败原因在回执里,模型会转述。
 */
import { ImageIcon } from 'lucide-react'
import { motion } from 'motion/react'
import { useCallback, useState, type ReactNode } from 'react'
import { pick } from '../../../../shared/domain/tool-presenter'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { useMotionLevel, type MotionLevel } from '../../theme/useMotionLevel'
import { AgentShimmerText } from './AgentActivity'
import { DETAIL_CARD_CLASS } from './detail-card'
import { imageGenView, type ImageGenSlot } from './image-gen-view'
import { ImageLightbox } from './ImageLightbox'
import { OutputBlock, type DetailProps } from './ToolDetail'

export function ImageGenDetail({ input, output, isError, partialImages }: DetailProps): ReactNode {
  const { t } = useI18n()
  const level = useMotionLevel()
  /** 灯箱打开时是第几张(在「已有的图」里的位置,不是格子序号);null = 没开 */
  const [zoomed, setZoomed] = useState<number | null>(null)
  // 需求:灯箱在监听键盘的 effect 里依赖 onClose —— 每次渲染换一个新函数会让它在
  // 逐张出图的每一次重渲里都重挂一遍监听、把焦点重抢回关闭钮
  const close = useCallback(() => setZoomed(null), [])

  // 失败时只给原因:此时入参里的 n 格占位全是空承诺(全失败才会走到 isError,见桥的 run)
  if (isError) return <OutputBlock output={output} isError maxLines={20} />

  const view = imageGenView(input, output, partialImages)
  const images = view.slots.flatMap((slot) => (slot.kind === 'image' ? [slot.image] : []))
  const single = view.slots.length === 1
  const settled = output !== undefined
  const prompt = pick(input, 'prompt').trim()
  let imagePosition = 0

  return (
    <div
      role="group"
      aria-label={t('imageGen.card.region')}
      data-testid="image-gen-card"
      data-image-gen-done={view.done}
      data-image-gen-requested={view.requested}
      className={cn(DETAIL_CARD_CLASS, 'p-1.5', !single && 'max-w-[520px]')}
    >
      <div className={cn(single ? 'flex' : 'grid grid-cols-2 gap-1.5')}>
        {view.slots.map((slot) => {
          if (slot.kind === 'loading') {
            return (
              <LoadingSlot
                key={`slot:${String(slot.index)}`}
                single={single}
                level={level}
                label={t(view.mode === 'edit' ? 'imageGen.card.editing' : 'imageGen.card.generating')}
                ariaLabel={t('imageGen.card.slot', { index: slot.index + 1, total: view.requested })}
              />
            )
          }
          const position = imagePosition
          imagePosition += 1
          return (
            <ImageSlot
              key={`slot:${String(slot.index)}`}
              slot={slot}
              single={single}
              // 只给**生成期到手**的那几张播淡入:跑完/重开历史会话时整片图一起淡入是开场动画,不是反馈
              reveal={!settled}
              label={t('imageGen.card.open', { index: position + 1 })}
              onOpen={() => setZoomed(position)}
            />
          )
        })}
      </div>
      {(prompt !== '' || view.partial) && (
        <div className="flex items-start gap-2 px-1 pt-1.5 pb-0.5 text-[12px] leading-relaxed text-fg-faint">
          {/* prompt 是领域值(模型写的「要画什么」),不翻译;行里只放得下前 48 字,这里给全 */}
          {prompt !== '' && <p className="selectable line-clamp-3 min-w-0 flex-1">{prompt}</p>}
          {view.partial && (
            <span data-testid="image-gen-partial" className="ml-auto shrink-0 text-danger">
              {t('imageGen.card.partial', { done: view.done, total: view.requested })}
            </span>
          )}
        </div>
      )}
      {zoomed !== null && images.length > 0 && (
        <ImageLightbox images={images} startIndex={Math.min(zoomed, images.length - 1)} onClose={close} />
      )}
    </div>
  )
}

/**
 * 一格加载占位。
 *
 * ★ 动效分三档,各有理由(AGENTS §8):standard/soft 用 CSS 光带(`.image-gen-sweep`);
 * reduced 下 CSS 动画会被主题层压成 0,但「还在画」这件事仍要表达 —— 和
 * `AgentActivityGrid` 同一个办法,用 Motion 做**无位移**的透明度呼吸;off 保持静止,
 * 那时承载信息的是状态字本身。
 */
function LoadingSlot({
  single,
  level,
  label,
  ariaLabel
}: {
  /** 只有一格时用大方格,多格时撑满网格列 */
  single: boolean
  level: MotionLevel
  /** 格子里那句状态字(生成中 / 编辑中) */
  label: string
  /** 读屏念「第 2/4 张」—— 视觉上格子位置已经说明了这件事,读屏没有位置 */
  ariaLabel: string
}): ReactNode {
  const sweep = level === 'standard' || level === 'soft'
  const icon = <ImageIcon size={single ? 22 : 18} aria-hidden />
  return (
    <div
      role="status"
      aria-label={ariaLabel}
      data-testid="image-gen-loading"
      className={cn(
        'relative flex aspect-square flex-col items-center justify-center gap-2 overflow-hidden rounded-[8px] bg-tint text-fg-faint',
        single ? 'w-full max-w-[320px]' : 'w-full',
        sweep && 'image-gen-sweep'
      )}
    >
      {level === 'reduced' ? (
        <motion.span
          className="flex"
          animate={{ opacity: [1, 0.4, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          {icon}
        </motion.span>
      ) : icon}
      <span className="text-[11.5px]">
        <AgentShimmerText>{label}</AgentShimmerText>
      </span>
    </div>
  )
}

function ImageSlot({
  slot,
  single,
  reveal,
  label,
  onOpen
}: {
  slot: Extract<ImageGenSlot, { kind: 'image' }>
  /** 单张按原比例显示;多张统一裁成方格,网格才对得齐 —— 原图在灯箱里 */
  single: boolean
  /** 这张是不是刚在生成期到手的 —— 只有它们播淡入 */
  reveal: boolean
  /** 读屏标签「放大查看第 N 张图片」 */
  label: string
  onOpen: () => void
}): ReactNode {
  return (
    // button 而不是给 img 挂 onClick:键盘要能 Tab 到并回车打开(同 MessageImage 的理由)
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className={cn(
        'app-no-drag block cursor-zoom-in overflow-hidden rounded-[8px] focus-visible:outline-2 focus-visible:outline-accent',
        reveal && 'image-gen-reveal'
      )}
    >
      <img
        src={slot.image.dataRef}
        alt=""
        data-testid="image-gen-image"
        className={cn(
          'block',
          single ? 'max-h-[360px] max-w-full object-contain' : 'aspect-square w-full object-cover'
        )}
      />
    </button>
  )
}
