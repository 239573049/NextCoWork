import { AudioLines, Image, Mic, Video, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Modality } from "../../../../../shared/domain/pricing";
import { EmptyState } from "../../../components/ui/EmptyState";

/**
 * 四个铺出来但本轮没有内容的模态 Tab。照 `pages/StubPage.tsx` 的规矩:
 * **直说缺的是什么,不写「即将推出」。**
 *
 * ★ 四条理由**刻意不是同一句话**。共同的那半(编解码只有文本一条路)是真的,
 * 但另一半各不相同 —— `PriceTier` / `TokenRates` 的计价单位是「每百万 token」,
 * 它能表达图像的按次计费(`perCall` 字段已经留好),却表达不了视频的按秒、
 * 语音合成的按字符、语音识别的按分钟。把这条差别写出来,是因为将来接这几个
 * Tab 的人第一件要做的事就是**改定价的形状**,而不是再写一套编解码。
 *
 * ★ 只写计费的**单位**,一个价格数字都不写 —— 界面上的价必须来自
 * `pricing-seed.ts` 那张带 `source` 与 `fetchedAt` 的表。
 */
type DeadModality = Exclude<Modality, "text">;

const REASON: Record<
  DeadModality,
  { icon: LucideIcon; title: string; hint: string }
> = {
  image: {
    icon: Image,
    title: "图像生成本轮不做",
    hint: "上游编解码只有文本一条路。定价的形状倒是留好了 —— TokenRates.perCall 就是给按次计费的生图用的。",
  },
  video: {
    icon: Video,
    title: "视频生成本轮不做",
    hint: "除了编解码,定价也套不上:各家普遍按秒和分辨率计价,而 TokenRates 的单位是每百万 token。",
  },
  speech: {
    icon: AudioLines,
    title: "语音生成本轮不做",
    hint: "同上。语音合成普遍按字符计费,现在的费率表达不了,接它要先改 PriceTier 的形状。",
  },
  transcription: {
    icon: Mic,
    title: "语音识别本轮不做",
    hint: "同上。识别普遍按音频时长计费,这一维在 TokenRates 里同样没有对应字段。",
  },
};

export function StubModalityPage({
  modality,
}: {
  modality: DeadModality;
}): ReactNode {
  const r = REASON[modality];
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState icon={<r.icon size={26} />} title={r.title} hint={r.hint} />
    </div>
  );
}
