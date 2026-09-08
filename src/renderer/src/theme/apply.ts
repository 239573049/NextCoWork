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
import type { ImageTheme, ThemeTokens } from '../../../shared/domain/theme'
import { THEME_TOKENS, resolveImageTheme, tokensOf } from '../../../shared/domain/theme'

/**
 * 图片主题的底图。`blur` / `overlay` 两种渲染方式落成 `<html>` 上的
 * `data-image-render`,具体怎么画交给 CSS —— 免得把视觉细节焊死在这里。
 */
const IMAGE_VAR = '--theme-image'

/**
 * ★ **渐变和位图在面板上不是一回事,所以得分开写。**
 *
 * 六张内置图是 CSS 渐变 —— 它们**没有纹理**,放大、模糊、压色都变不出细节。
 * 这一层还挂在窗口底层的时候无所谓:只有 8px 的缝会露出来,一道饱和的渐变
 * 当环境光正好。铺满 959×804 的面板之后同一个值就成了一整块平的实色 ——
 * 看着不像壁纸,像给面板刷了个背景色。上传的位图没有这个问题,它自带纹理。
 *
 * 这个差别 CSS 判断不了,只能由这里把源的种类交出去(`builtin` / `uploaded`),
 * 让 `theme.css` 给渐变那一档单独压一个不透明度。实测两档的分界很清楚:
 * 位图 0.55 是壁纸、0.30 就快没了;渐变 0.55 是色块、0.30 才退成一层染色。
 */
const SOURCE_ATTR = 'imageSource'

/**
 * 返回**这一次写下去的那 22 个值**。不是顺手加的:Windows/Linux 标题栏那三颗
 * 系统按钮不是 DOM,颜色只能经 IPC 推给主进程,而调用点要拿到 `chrome` / `icon`
 * 就得再算一次 `tokensOf` —— 同一份输入算两遍,迟早有一遍的参数会漏掉更新
 * (`uploaded` 这一路尤其容易忘)。这里原样交出去,两边永远是同一个结果。
 */
export function applyTheme(
  root: HTMLElement,
  appearance: ResolvedTheme,
  settings: AppSettings,
  uploaded: readonly ImageTheme[] = []
): ThemeTokens {
  root.dataset['theme'] = appearance

  const image = resolveImageTheme(settings.imageTheme.id, uploaded)
  const tokens = tokensOf(appearance, settings.colorTheme, image)

  // 22 个全写一遍,不做差量:上一次写的值总会被这一次盖掉,
  // 也就不存在「换主题之后还剩一个旧色」这种半截状态。
  for (const k of THEME_TOKENS) root.style.setProperty(`--color-${k}`, tokens[k])

  const backdrop = backdropOf(image)
  if (backdrop === null) {
    root.style.removeProperty(IMAGE_VAR)
    delete root.dataset['imageRender']
    delete root.dataset[SOURCE_ATTR]
    return tokens
  }
  root.style.setProperty(IMAGE_VAR, backdrop)
  root.dataset['imageRender'] = settings.imageTheme.render
  // `image` 在这条分支上一定不是 null —— `backdropOf` 只对 null 返回 null
  root.dataset[SOURCE_ATTR] = image?.source.kind ?? 'builtin'
  return tokens
}

/**
 * ★ **整套颜色不依赖那张图能不能读出来。** 种子色是跟着 `ImageTheme` 一起存的,
 * 上面 `tokensOf` 只用到 `seed` —— 所以位图还没加载出来的那几帧里,
 * 界面已经是正确的颜色了,只是底图还没铺上。位图读失败也就只是没底图,
 * 不会退化成「一半新色一半旧色」。
 *
 * ★ 底图 URL 现在**直接来自 `image.source.url`**(`ncw://` 协议地址)。
 * 原先这里要收一张 `assetId → blob: URL` 的映射表,因为显示本地图必须先把
 * 字节传过来 —— 那张表连同它的懒兑现、并发去重、revoke 生命周期一起没了。
 */
function backdropOf(image: ImageTheme | null): string | null {
  if (image === null) return null
  if (image.source.kind === 'builtin') return image.source.css
  return image.source.url === undefined || image.source.url === ''
    ? null
    : `url("${image.source.url}")`
}
