/**
 * visualize read_me 的 `art` 模块规范 —— 逐字取自 Anthropic 的 `visualize:read_me` 响应。
 *
 * 需求:插画与生成式图形的画法。模型在写 widget 之前先读它,而不是每次从零试错 ——
 * 它是 `visualize_read_me` 的返回值本体(`visualize.ts`)。
 *
 * ★ **正文一个字都不许改。** 这是量出来的规范,不是我们的文案:改掉其中任何一个
 * 数值(比如那条"每层 ≤4 个盒子")不会报任何错,只会让模型稳定地画坏图 ——
 * 表现是"图画出来了,但一眼就是歪的",而没人会去怀疑一段说明文字。
 * 要调整规范就整段替换,并注明来源与日期,不要就地润色。
 *
 * ★ 里面的 `--color-*` 是 **Claude 的设计变量名**,不是本仓库的 token 名。
 * 外壳会把这些变量按当前主题注入进 iframe(`renderer/theme/widget-tokens.ts`),
 * 所以这段原文在这里是可直接执行的,不需要翻译成我们的 token。
 *
 * 来源:Anthropic 的 claude.ai `visualize:read_me` 工具响应,经
 * `Michaelliv/pi-generative-ui`(MIT)从会话导出 JSON 中逐字抠出并核对一致。
 * 正文版权归 Anthropic。改动本文件请连同 `visualize-guidelines/index.ts` 的模块映射一起看。
 */

export const ART_AND_ILLUSTRATION = `## Art and illustration
*"Draw me a sunset" / "Create a geometric pattern"*

Use \`imagine_svg\`. Same technical rules (viewBox, safe area) but the aesthetic is different:
- Fill the canvas — art should feel rich, not sparse
- Bold colors: mix \`--color-text-*\` categories for variety (info blue, success green, warning amber)
- Art is the one place custom \`<style>\` color blocks are fine — freestyle colors, \`prefers-color-scheme\` for dark mode variants if you want them
- Layer overlapping opaque shapes for depth
- Organic forms with \`<path>\` curves, \`<ellipse>\`, \`<circle>\`
- Texture via repetition (parallel lines, dots, hatching) not raster effects
- Geometric patterns with \`<g transform="rotate()">\` for radial symmetry`
