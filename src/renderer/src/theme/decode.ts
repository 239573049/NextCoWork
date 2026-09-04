/**
 * 从上传的位图里取颜色 —— 导入第二相的全部内容。
 *
 * ★ **这一步只能在渲染层做**,这也是导入分两相的唯一理由:取色要先把图解码成
 * RGBA,而解码器(`createImageBitmap`)住在 Chromium 里,主进程没有。
 *
 * ★ 这个文件在 vitest 里**跑不起来**(测试环境是 node,没有 canvas),所以它
 * 刻意只做两件事:缩图、把像素递给 `extractPalette`。**所有判断都在那边** ——
 * 那边是纯函数,有测试。这里多写一行逻辑,就多一行没人验证的逻辑。
 */
import { extractPalette } from '../../../shared/domain/theme'

/**
 * 缩到多大再取色。`extractPalette` 的文档说 ~64,这里取 128 ——
 * 128² ≈ 16k 像素,正好在它 20k 的抽样上限之内(于是每个像素都算数),
 * 而缩得越狠、相邻像素平均得越厉害,**鲜艳的那一小块越容易被抹成灰**,
 * 恰好撞在 `chroma < 24` 那道门槛上。取色取出一片灰,是这里最难查的失败。
 */
const MAX_EDGE = 128

export interface DecodedColors {
  /** 主色。整套 token 由它经 `specFromSeed` 派生 */
  seed: string
  /** 卡片下面那几颗色点 */
  palette: string[]
}

export async function decodeColors(
  bytes: Uint8Array<ArrayBuffer>,
  mime: string
): Promise<DecodedColors> {
  // `bytes` 刚经 IPC 结构化克隆过来,已经是这一侧的副本,拿去建 Blob 是安全的
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))

    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    if (ctx === null) throw new Error('拿不到 2d 绘图上下文')
    ctx.drawImage(bitmap, 0, 0, w, h)

    const palette = extractPalette(ctx.getImageData(0, 0, w, h).data, 4)
    const seed = palette[0]
    // 实际到不了这里(`extractPalette` 灰度图也会补齐到 count 个),
    // 但 seed 是要写进 CSS 变量的,不给它留一条 undefined 的路
    if (seed === undefined) throw new Error('这张图里取不出颜色')
    return { seed, palette }
  } finally {
    // 不 close 的话这块解码后的位图要等 GC —— 4K 图就是几十 MB
    bitmap.close()
  }
}
