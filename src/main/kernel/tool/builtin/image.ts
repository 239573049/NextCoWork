/*
 * `generate_image` —— 对话里「画一张 / 改这张」的落地点。
 *
 * 需求:设置页「图片生成」tab 配好的生图供应商,要在对话里真的能用:
 * 1. 文生图:只给 `prompt`;
 * 2. 改图:`image: "latest"`(对话里最近一张图——用户刚上传的附件、或上一轮
 *    自己生成的那张)、`image: <工作区图片路径>`,或 `image: <http(s) 图片 URL>`。
 *
 * 这个工具只负责「把 prompt 和源图递出去、把图接回来」;用哪个模型、哪把密钥、
 * `/images/edits` 的形状兼容、`ncw://` 附件的安全解析全在桥里
 * (`kernel/image-gen.ts` + `upstream/images.ts`),所以这里零 store、零凭证接触。
 *
 * ★ `isEnabled` 是**不做防御式 UI** 的那半:没选生图模型(设置里 `imageModel`
 * 空着或解析不到)时整个工具不下发,模型看不到一个注定失败的承诺
 * (而不是下发了再回一句「没配」)。
 * 反过来,配了模型但没配 key 时**照常下发** —— 密钥要读 secrets(异步),
 * 同步谓词答不了,而调用时那句 `no API key` 本身就是可行动的反馈
 * (理由全文见 `ImageGenBridge.available` 上那段)。
 *
 * ★ `readOnly: true`:它不写盘、不改任何工作区状态,产出只挂在这条工具结果上
 * —— 与 `browser_screenshot` / `visualize_show_widget` 同一档(代价是权限闸门
 * 对它一路放行)。原先还有「联网开关仍然管得住它」这层兜底;用户把「联网搜索」
 * 收窄成只管网页搜索与抓取之后,管住它的是它**自己的**开关
 * (`AppSettings.imageGenerationEnabled`,经桥的 `available()` / `enabled()` 生效)。
 */
import { z } from 'zod'
import type { AgentMessage } from '../../../../shared/agent/message'
import type { ToolResult } from '../../../../shared/agent/tool'
import { toolFail, toolOk } from '../../../../shared/agent/tool'
import { imageMimeOfBytes, MAX_ATTACHMENT_BYTES } from '../../../../shared/domain/attachment'
import { defineTool } from '../define'
import { downloadImage, type ImageSource } from '../../image-gen'
import type { ToolContext, ToolRegistration } from '../registry'
import { resolvePath } from './paths'

/** `image` 参数取这个字面量 = 「对话里最近一张图」(与文件路径区分开的关键词) */
const LATEST = 'latest'

const GenerateImageInput = z.object({
  prompt: z.string().min(1).describe('What to draw — a detailed natural-language description of the image'),
  image: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Which image to edit: "latest" for the most recent image in this conversation, a workspace file path, ' +
        'or an http(s) URL of an image. Omit it to generate a new image from the prompt alone.'
    )
})

/**
 * 往回找对话里最近的一张图。
 *
 * 需求:模型**看不到**图片的 dataRef(图是以图像块发给它的,转录里的引用字符串
 * 不进它的上下文),所以它没法「点名」某张图 —— 只能由我们替它认最近那张。
 * 用户说「把这张改成黑白」时,「这张」几乎总是刚发来的附件或刚生成的那张。
 *
 * ★ 两种来源都要认:消息里的 `image` part(用户附件,可能是 `ncw://` 未解析引用)
 * 和工具结果里的 `output.images`(截图 / 上一轮生图,内联 data URL)。
 * 从**后往前**扫 —— 取到的就是「刚才那张」。
 */
function latestImage(messages: readonly AgentMessage[] | undefined): ImageSource | null {
  if (messages === undefined) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parts = messages[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j]
      if (part === undefined) continue
      if (part.type === 'image') return { mime: part.mime, dataRef: part.dataRef }
      if (part.type === 'tool_result') {
        const image = part.output.images?.[0]
        if (image !== undefined) return { mime: image.mime, dataRef: image.dataRef }
      }
    }
  }
  return null
}

/**
 * 工作区里的一张图 → data URL。
 *
 * ★ 路径必须过 `resolvePath`(和 `Read` 同一条归一化/围栏,理由见 `fs.ts` 文件头);
 * 字节用**魔数**认 mime(`imageMimeOfBytes`),不信扩展名 —— 改过名的 `.png` 里
 * 装着 JPEG 时,自报的 mime 会让上游按错的类型解码。
 * ★ 大小上限沿用附件那条 32MB:比这更大的图上游多半也拒,先在这儿说人话。
 */
async function readWorkspaceImage(rawPath: string, ctx: ToolContext): Promise<ImageSource> {
  const resolved = await resolvePath(ctx, rawPath)
  if (!resolved.ok) throw new Error(resolved.result.output.content)
  const { fs } = ctx.host
  if (!(await fs.exists(resolved.abs))) throw new Error(`File does not exist: ${rawPath}`)
  const stat = await fs.stat(resolved.abs)
  if (stat.isDir) throw new Error(`${rawPath} is a directory, not an image file`)
  if (stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Image file size (${String(stat.size)} bytes) is outside the allowed range of 1–${String(MAX_ATTACHMENT_BYTES)} bytes`
    )
  }
  const bytes = await fs.readFileBytes(resolved.abs, stat.size + 1)
  if (bytes.length !== stat.size) throw new Error(`Image file changed while it was being read: ${rawPath}`)
  const mime = imageMimeOfBytes(bytes)
  if (mime === null) throw new Error(`Unrecognized image format: ${rawPath} (jpg/png/gif/webp only)`)
  return { mime, dataRef: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` }
}

const generateImageTool: ToolRegistration = defineTool({
  internalId: 'generate_image',
  description:
    'Generate an image from a text prompt, or edit an existing one, using the image provider configured in this app ' +
    '(Settings > Models > Image generation). The resulting image is returned inline in the tool result so the user can see it.\n' +
    '- Generate: pass only `prompt`.\n' +
    '- Edit: pass `image` as "latest" to modify the most recent image in this conversation, a workspace file path, or an image URL.\n' +
    'A URL that cannot be downloaded is an error — the tool will not fall back to generating a new image.\n' +
    'Use it whenever the user asks to draw, paint, illustrate, render, generate, or modify a picture, photo, or artwork. ' +
    'It does not write files — use Write when the user wants the image saved to disk.',
  schema: GenerateImageInput,
  readOnly: true,
  destructive: false,
  // 事实描述:生图/改图真出网(POST 生图接口、下载 URL 源图)。它**不再**让「联网搜索」
  // 开关管住这个工具 —— 那颗开关只按 NETWORK_SWITCH_TOOLS 名单判;生图的启停看
  // `AppSettings.imageGenerationEnabled`(见文件头 readOnly 那段)
  needsNetwork: true,
  isEnabled: (ctx) => ctx.imageGen?.available() === true,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.imageGen === undefined) {
      // isEnabled 已经挡住正常路径;这里兜的是「快照之后桥被摘掉」的窄窗口 ——
      // 必须是 toolFail:报成功却没有图,模型会向用户宣布「已经画好了」
      return toolFail('Image generation is not available in this environment.')
    }

    let source: ImageSource | undefined
    if (input.image !== undefined) {
      if (input.image === LATEST) {
        const latest = latestImage(ctx.messages)
        // 没有图可改时当场说清,而不是硬发一个没有 image 的 edits 请求 ——
        // 那种 400 读不出和「对话里根本没有图」的关系
        if (latest === null) {
          return toolFail('There is no image in this conversation to edit. Ask the user to attach one, or pass a workspace file path or an image URL.')
        }
        source = latest
      } else if (input.image.startsWith('http://') || input.image.startsWith('https://')) {
        /*
          ★ 需求:模型传了图片 URL 就是要改**这一张** —— 下载失败 / 404 / 不是图片
          时必须失败,**绝不回落成文生图**。回落的症状是用户说「把这张图改成黑白」,
          模型却悄悄画了一张全新的图、还向用户宣布改好了;而 URL 死了这件事
          (图床过期、链接贴错)就此永远传不到用户耳朵里。
          下载走 `downloadImage`:与「上游回包里的 url」共用同一条实现
          (逐跳 ssrfRisk、跳转手动跟、32MB 上限、魔数认格式)。
          这里直接抛出去 —— `defineTool` 把普通错误翻成 toolFail 带上原因,
          中断照旧上抛(`isAbortError` 分流),不会被这句话吞掉。
        */
        source = await downloadImage(ctx.host.fetch, input.image, ctx.signal)
      } else {
        source = await readWorkspaceImage(input.image, ctx)
      }
    }

    const result =
      source === undefined
        ? await ctx.imageGen.generate(input.prompt, ctx.signal)
        : await ctx.imageGen.edit(input.prompt, source, ctx.signal)
    const action = source === undefined ? 'Generated' : 'Edited'
    return toolOk(
      `${action} 1 image with ${result.model} via ${result.providerName}. The image is attached below.`,
      { images: result.images }
    )
  }
})

export { generateImageTool }
