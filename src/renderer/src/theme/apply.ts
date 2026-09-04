/**
 * 把设置里那三样(外观模式 / 颜色主题 / 图片主题)真正写到界面上。
 *
 * ★ **写的是 `<html>` 的行内样式,不是往 `<head>` 里塞 `<style>`。**
 * `theme.css` 里 `@theme` 生成的是 `:root { --color-app: … }`,浅色那套是
 * `:root[data-theme='light']` —— 行内样式比这两者都强(它压根不参与选择器优先级),
 * 所以这一份写下去,两个外观下都稳稳生效,不用关心谁先谁后。
 *
 * ★ **`theme.css` 那两套值必须留着,它们是首屏。** 握手回来之前
 * (`app:getBootstrap` 是一次 IPC 往返)界面已经画出来了,那一帧靠的就是 CSS 里
 * 写死的墨绿。删掉它们的话首屏是一片没有颜色的白,然后「啪」地跳成深色。
 *
 * 这个文件刻意只做「写 DOM」这一件事 —— 所有判断都在
 * `shared/domain/theme.ts` 里(那边在 vitest 里跑得起来,这边不行:
 * 测试环境是 node,没有 document)。
 */
import type { AppSettings, ResolvedTheme } from '../../../shared/domain/settings'
import type { ImageTheme } from '../../../shared/domain/theme'
import { THEME_TOKENS, resolveImageTheme, tokensOf } from '../../../shared/domain/theme'

/**
 * 图片主题的底图。`blur` / `overlay` 两种渲染方式落成 `<html>` 上的
 * `data-image-render`,具体怎么画交给 CSS —— 免得把视觉细节焊死在这里。
 */
const IMAGE_VAR = '--theme-image'

export function applyTheme(
  root: HTMLElement,
  appearance: ResolvedTheme,
  settings: AppSettings,
  uploaded: readonly ImageTheme[] = [],
  assetUrls: ReadonlyMap<string, string> = new Map()
): void {
  root.dataset['theme'] = appearance

  const image = resolveImageTheme(settings.imageTheme.id, uploaded)
  const tokens = tokensOf(appearance, settings.colorTheme, image)

  // 22 个全写一遍,不做差量:上一次写的值总会被这一次盖掉,
  // 也就不存在「换主题之后还剩一个旧色」这种半截状态。
  for (const k of THEME_TOKENS) root.style.setProperty(`--color-${k}`, tokens[k])

  const backdrop = backdropOf(image, assetUrls)
  if (backdrop === null) {
    root.style.removeProperty(IMAGE_VAR)
    delete root.dataset['imageRender']
    return
  }
  root.style.setProperty(IMAGE_VAR, backdrop)
  root.dataset['imageRender'] = settings.imageTheme.render
}

/**
 * ★ **整套颜色不依赖那张图能不能读出来。** 种子色是跟着 `ImageTheme` 一起存的,
 * 上面 `tokensOf` 只用到 `seed` —— 所以主进程还没把位图递过来的那几帧里,
 * 界面已经是正确的颜色了,只是底图还没铺上。位图读失败也就只是没底图,
 * 不会退化成「一半新色一半旧色」。
 *
 * `assetUrls` 是 assetId → `blob:` URL 的表,由上传流程维护
 * (`theme:readImage` 拿到字节 → `URL.createObjectURL`)。取不到就当作没底图。
 */
function backdropOf(image: ImageTheme | null, assetUrls: ReadonlyMap<string, string>): string | null {
  if (image === null) return null
  if (image.source.kind === 'builtin') return image.source.css
  const url = assetUrls.get(image.source.assetId)
  return url === undefined ? null : `url("${url}")`
}
