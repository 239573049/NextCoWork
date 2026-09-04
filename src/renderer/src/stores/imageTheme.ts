/**
 * 上传的图片主题 —— 表 + `assetId → blob: URL` 的映射。
 *
 * 为什么是 store 而不是 props:**两个互不相邻的消费者**。`App.tsx` 要拿它喂
 * `applyTheme`(整套 token 由选中那张图的 seed 派生),设置页要拿它画卡片。
 * 走 props 就得从 App 一路穿过 AppShell、设置浮层、才到那一页。
 *
 * ★ **blob URL 是懒建的。** 上限是 40 张 × 16MB —— 开机就把每张图的字节都拉过来,
 * 最坏情况是几百 MB 常驻内存,而其中至多有一张正被用作底图。所以:
 * - `load(selectedId)` 只拉表 + 兑现**选中的那一张**;
 * - 设置页挂载时调 `ensureAll()` 兑现其余的(那时用户正看着这些卡片)。
 *
 * 兑现之前卡片画的是 `theme.seed` 那块纯色(见 `ImageCard`),而底图那一层
 * 取不到 URL 就当没有(见 `apply.ts` 的 `backdropOf`)—— 两处都不会白屏或闪。
 */
import { create } from 'zustand'
import type { ImageTheme } from '../../../shared/domain/theme'
import { IMAGE_THEMES } from '../../../shared/domain/theme'
import { deleteImage, importImage, listImages, readImage, saveImage } from '../services/theme'
import { decodeColors } from '../theme/decode'

interface ImageThemeStore {
  uploaded: ImageTheme[]
  /** assetId → `blob:` URL。没有这一项 = 还没兑现,不是「这张图坏了」 */
  urls: ReadonlyMap<string, string>
  /** 拉表(只拉一次)+ 兑现选中的那张。`selectedId` 是内置 id 或 null 时只拉表 */
  load: (selectedId: string | null) => Promise<void>
  /** 兑现全部 —— 设置页挂载时调 */
  ensureAll: () => Promise<void>
  /** 走完两相导入。取消返回 null;解码失败会抛,由调用点显示 */
  importOne: () => Promise<ImageTheme | null>
  remove: (id: string) => Promise<void>
}

/** 拉表只该发生一次,并发调用共用同一个 promise */
let listing: Promise<ImageTheme[]> | null = null
/** 正在兑现的 id,防同一张图并发拉两次字节 */
const inFlight = new Set<string>()

export const useImageThemes = create<ImageThemeStore>((set, get) => ({
  uploaded: [],
  urls: new Map(),

  load: async (selectedId) => {
    listing ??= listImages()
    set({ uploaded: await listing })
    if (selectedId !== null) await ensure(selectedId)
  },

  ensureAll: async () => {
    await Promise.all(get().uploaded.map((t) => ensure(t.id)))
  },

  importOne: async () => {
    const picked = await importImage()
    if (picked === null) return null

    // 解码在这一侧(主进程没有 canvas)。抛在这里是**对的** ——
    // 主进程那边留下的是一个没进表的孤儿文件,下次启动扫掉;
    // 而写进表的每一条都保证颜色是算出来的,不是猜的
    const { seed, palette } = await decodeColors(picked.bytes, picked.mime)
    const uploaded = await saveImage({ id: picked.id, name: picked.name, seed, palette })

    // 字节已经在手上了,不必再走一次 theme:readImage
    const url = URL.createObjectURL(new Blob([picked.bytes], { type: picked.mime }))
    set((s) => ({ uploaded, urls: new Map(s.urls).set(picked.id, url) }))
    return uploaded.find((t) => t.id === picked.id) ?? null
  },

  remove: async (id) => {
    const uploaded = await deleteImage(id)
    set((s) => {
      const urls = new Map(s.urls)
      const url = urls.get(id)
      // 不 revoke 的话这块字节要活到页面关闭为止 —— 而它指向的文件已经删了
      if (url !== undefined) URL.revokeObjectURL(url)
      urls.delete(id)
      return { uploaded, urls }
    })
  }
}))

/**
 * 把一张图的字节换成 `blob:` URL。已经有了、正在拉、或者根本是内置主题,都直接返回。
 *
 * 失败不抛:取不到 URL 只意味着底图那一层不画(`backdropOf` 返回 null),
 * 颜色仍然由 `seed` 决定 —— 整个界面照样是对的,只是少一层背景图。
 * 为这个把设置页整页崩掉,不值当。
 */
async function ensure(id: string): Promise<void> {
  const { urls } = useImageThemes.getState()
  // 内置那六张是渐变配方,没有文件可读 —— 这一句省掉的是每次开机一次
  // 必然失败的 IPC 往返,以及主进程里一条看着像故障的日志
  if (urls.has(id) || inFlight.has(id) || IMAGE_THEMES.some((t) => t.id === id)) return

  inFlight.add(id)
  try {
    const { mime, bytes } = await readImage(id)
    // 拉的这段时间里可能已经被删了 —— 再建 URL 就是泄漏一块永远没人用的字节
    if (!useImageThemes.getState().uploaded.some((t) => t.id === id)) return
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    useImageThemes.setState((s) => ({ urls: new Map(s.urls).set(id, url) }))
  } catch {
    // 文件被人从 userData 里删了。主进程那边已经顺手把这条记录清掉了
  } finally {
    inFlight.delete(id)
  }
}
