/**
 * 上传的图片主题 —— 就是一张表。
 *
 * ## 这个文件曾经有一半是在绕「显示本地图要先传字节」
 *
 * 迁到 `ncw://` 协议之前,这里还维护着一张 `assetId → blob: URL` 的映射,
 * 外加:懒兑现(开机不拉 40 张图的字节)、`inFlight` 去重(防同一张并发拉两次)、
 * `revokeObjectURL`(不 revoke 就泄漏)、以及「拉的过程中这张图被删了」的竞态处理。
 *
 * **那四样东西的存在理由是同一条限制,而协议把它取消了。** 现在
 * `ImageTheme.source.url` 是主进程给的 `ncw://` 地址,`<img src>` 直接用,
 * 缓存与解码归 Chromium 管。整个兑现机制连同它的竞态一起删掉了。
 *
 * 导入仍走字节 —— 那一相是**必须**的:主进程没有 canvas,算不出种子色,
 * 而色板要在落表之前算好。所以这是「显示走协议、导入走字节」的半迁移。
 */
import { create } from 'zustand'
import type { ImageTheme } from '../../../shared/domain/theme'
import { deleteImage, importImage, listImages, saveImage } from '../services/theme'
import { decodeColors } from '../theme/decode'

interface ImageThemeStore {
  uploaded: ImageTheme[]
  /** 拉表(只拉一次)。`selectedId` 不再有用 —— 没有「兑现」这回事了 */
  load: () => Promise<void>
  /** 走完两相导入。取消返回 null;解码失败会抛,由调用点显示 */
  importOne: () => Promise<ImageTheme | null>
  remove: (id: string) => Promise<void>
}

/** 拉表只该发生一次,并发调用共用同一个 promise */
let listing: Promise<ImageTheme[]> | null = null

export const useImageThemes = create<ImageThemeStore>((set) => ({
  uploaded: [],

  load: async () => {
    listing ??= listImages()
    set({ uploaded: await listing })
  },

  importOne: async () => {
    const picked = await importImage()
    if (picked === null) return null

    // 解码在这一侧(主进程没有 canvas)。抛在这里是**对的** ——
    // 主进程那边留下的是一个没进表的孤儿文件,下次启动扫掉;
    // 而写进表的每一条都保证颜色是算出来的,不是猜的
    const { seed, palette, metadata } = await decodeColors(picked.bytes, picked.mime)
    const uploaded = await saveImage({ id: picked.id, name: picked.name, seed, palette, metadata })

    // ★ 落表之后这张图立刻可以用 url 显示 —— 不必再把手上的字节转成 blob URL,
    //   也就不必记着将来 revoke 它
    set({ uploaded })
    // 表变了,缓存的 listing 作废,否则下次 load 会拿回旧表
    listing = Promise.resolve(uploaded)
    return uploaded.find((t) => t.id === picked.id) ?? null
  },

  remove: async (id) => {
    const uploaded = await deleteImage(id)
    set({ uploaded })
    listing = Promise.resolve(uploaded)
  }
}))
