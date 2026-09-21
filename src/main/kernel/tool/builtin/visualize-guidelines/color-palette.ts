/**
 * visualize read_me 的 `配色` 模块规范 —— 逐字取自 Anthropic 的 `visualize:read_me` 响应。
 *
 * 需求:九条色阶、每档 7 个色值，以及"颜色编码语义而非序列"那几条硬规则。模型在写 widget 之前先读它,而不是每次从零试错 ——
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

export const COLOR_PALETTE = `## Color palette

9 color ramps, each with 7 stops from lightest to darkest. 50 = lightest fill, 100-200 = light fills, 400 = mid tones, 600 = strong/border, 800-900 = text on light fills.

| Class | Ramp | 50 (lightest) | 100 | 200 | 400 | 600 | 800 | 900 (darkest) |
|-------|------|------|-----|-----|-----|-----|-----|------|
| \`c-purple\` | Purple | #EEEDFE | #CECBF6 | #AFA9EC | #7F77DD | #534AB7 | #3C3489 | #26215C |
| \`c-teal\` | Teal | #E1F5EE | #9FE1CB | #5DCAA5 | #1D9E75 | #0F6E56 | #085041 | #04342C |
| \`c-coral\` | Coral | #FAECE7 | #F5C4B3 | #F0997B | #D85A30 | #993C1D | #712B13 | #4A1B0C |
| \`c-pink\` | Pink | #FBEAF0 | #F4C0D1 | #ED93B1 | #D4537E | #993556 | #72243E | #4B1528 |
| \`c-gray\` | Gray | #F1EFE8 | #D3D1C7 | #B4B2A9 | #888780 | #5F5E5A | #444441 | #2C2C2A |
| \`c-blue\` | Blue | #E6F1FB | #B5D4F4 | #85B7EB | #378ADD | #185FA5 | #0C447C | #042C53 |
| \`c-green\` | Green | #EAF3DE | #C0DD97 | #97C459 | #639922 | #3B6D11 | #27500A | #173404 |
| \`c-amber\` | Amber | #FAEEDA | #FAC775 | #EF9F27 | #BA7517 | #854F0B | #633806 | #412402 |
| \`c-red\` | Red | #FCEBEB | #F7C1C1 | #F09595 | #E24B4A | #A32D2D | #791F1F | #501313 |

**How to assign colors**: Color should encode meaning, not sequence. Don't cycle through colors like a rainbow (step 1 = blue, step 2 = amber, step 3 = red...). Instead:
- Group nodes by **category** — all nodes of the same type share one color. E.g. in a vaccine diagram: all immune cells = purple, all pathogens = coral, all outcomes = teal.
- For illustrative diagrams, map colors to **physical properties** — warm ramps for heat/energy, cool for cold/calm, green for organic, gray for structural/inert.
- Use **gray for neutral/structural** nodes (start, end, generic steps).
- Use **2-3 colors per diagram**, not 6+. More colors = more visual noise. A diagram with gray + purple + teal is cleaner than one using every ramp.
- **Prefer purple, teal, coral, pink** for general diagram categories. Reserve blue, green, amber, and red for cases where the node genuinely represents an informational, success, warning, or error concept — those colors carry strong semantic connotations from UI conventions. (Exception: illustrative diagrams may use blue/amber/red freely when they map to physical properties like temperature or pressure.)

**Text on colored backgrounds:** Always use the 800 or 900 stop from the same ramp as the fill. Never use black, gray, or --color-text-primary on colored fills. **When a box has both a title and a subtitle, they must be two different stops** — title darker (800 in light mode, 100 in dark), subtitle lighter (600 in light, 200 in dark). Same stop for both reads flat; the weight difference alone isn't enough. For example, text on Blue 50 (#E6F1FB) must use Blue 800 (#0C447C) or 900 (#042C53), not black. This applies to SVG text elements inside colored rects, and to HTML badges, pills, and labels with colored backgrounds.

**Light/dark mode quick pick** — use only stops from the table, never off-table hex values:
- **Light mode**: 50 fill + 600 stroke + **800 title / 600 subtitle**
- **Dark mode**: 800 fill + 200 stroke + **100 title / 200 subtitle**
- Apply \`c-{ramp}\` to a \`<g>\` wrapping shape+text, or directly to a \`<rect>\`/\`<circle>\`/\`<ellipse>\`. Never to \`<path>\` — paths don't get ramp fill. For colored connector strokes use inline \`stroke="#..."\` (any mid-ramp hex works in both modes). Dark mode is automatic for ramp classes. Available: c-gray, c-blue, c-red, c-amber, c-green, c-teal, c-purple, c-coral, c-pink.

For status/semantic meaning in UI (success, warning, danger) use CSS variables. For categorical coloring in both diagrams and UI, use these ramps.`
