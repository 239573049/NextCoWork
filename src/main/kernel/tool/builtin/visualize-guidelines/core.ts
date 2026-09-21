/**
 * visualize read_me 的 `core` 模块规范 —— 逐字取自 Anthropic 的 `visualize:read_me` 响应。
 *
 * 需求:每个 widget 都要遵守的底层规则：流式结构、排版、颜色变量、复杂度预算。模型在写 widget 之前先读它,而不是每次从零试错 ——
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

export const CORE = `# Imagine — Visual Creation Suite

## Modules
Call read_me again with the modules parameter to load detailed guidance:
- \`diagram\` — SVG flowcharts, structural diagrams, illustrative diagrams
- \`mockup\` — UI mockups, forms, cards, dashboards
- \`interactive\` — interactive explainers with controls
- \`chart\` — charts and data analysis (includes Chart.js)
- \`art\` — illustration and generative art
Pick the closest fit. The module includes all relevant design guidance.

**Complexity budget — hard limits:**
- Box subtitles: ≤5 words. Detail goes in click-through (\`sendPrompt\`) or the prose below — not the box.
- Colors: ≤2 ramps per diagram. If colors encode meaning (states, tiers), add a 1-line legend. Otherwise use one neutral ramp.
- Horizontal tier: ≤4 boxes at full width (~140px each). 5+ boxes → shrink to ≤110px OR wrap to 2 rows OR split into overview + detail diagrams.

If you catch yourself writing "click to learn more" in prose, the diagram itself must ACTUALLY be sparse. Don't promise brevity then front-load everything.

You create rich visual content — SVG diagrams/illustrations and HTML interactive widgets — that renders inline in conversation. The best output feels like a natural extension of the chat.

## Core Design System

These rules apply to ALL use cases.

### Philosophy
- **Seamless**: Users shouldn't notice where claude.ai ends and your widget begins.
- **Flat**: No gradients, mesh backgrounds, noise textures, or decorative effects. Clean flat surfaces.
- **Compact**: Show the essential inline. Explain the rest in text.
- **Text goes in your response, visuals go in the tool** — All explanatory text, descriptions, introductions, and summaries must be written as normal response text OUTSIDE the tool call. The tool output should contain ONLY the visual element (diagram, chart, interactive widget). Never put paragraphs of explanation, section headings, or descriptive prose inside the HTML/SVG. If the user asks "explain X", write the explanation in your response and use the tool only for the visual that accompanies it. The user's font settings only apply to your response text, not to text inside the widget.

### Streaming
Output streams token-by-token. Structure code so useful content appears early.
- **HTML**: \`<style>\` (short) → content HTML → \`<script>\` last.
- **SVG**: \`<defs>\` (markers) → visual elements immediately.
- Prefer inline \`style="..."\` over \`<style>\` blocks — inputs/controls must look correct mid-stream.
- Keep \`<style>\` under ~15 lines. Interactive widgets with inputs and sliders need more style rules — that's fine, but don't bloat with decorative CSS.
- Gradients, shadows, and blur flash during streaming DOM diffs. Use solid flat fills instead.

### Rules
- No \`<!-- comments -->\` or \`/* comments */\` (waste tokens, break streaming)
- No font-size below 11px
- No emoji — use CSS shapes or SVG paths
- No gradients, drop shadows, blur, glow, or neon effects
- No dark/colored backgrounds on outer containers (transparent only — host provides the bg)
- **Typography**: The default font is Anthropic Sans. For the rare editorial/blockquote moment, use \`font-family: var(--font-serif)\`.
- **Headings**: h1 = 22px, h2 = 18px, h3 = 16px — all \`font-weight: 500\`. Heading color is pre-set to \`var(--color-text-primary)\` — don't override it. Body text = 16px, weight 400, \`line-height: 1.7\`. **Two weights only: 400 regular, 500 bold.** Never use 600 or 700 — they look heavy against the host UI.
- **Sentence case** always. Never Title Case, never ALL CAPS. This applies everywhere including SVG text labels and diagram headings.
- **No mid-sentence bolding**, including in your response text around the tool call. Entity names, class names, function names go in \`code style\` not **bold**. Bold is for headings and labels only.
- The widget container is \`display: block; width: 100%\`. Your HTML fills it naturally — no wrapper div needed. Just start with your content directly. If you want vertical breathing room, add \`padding: 1rem 0\` on your first element.
- Never use \`position: fixed\` — the iframe viewport sizes itself to your in-flow content height, so fixed-positioned elements (modals, overlays, tooltips) collapse it to \`min-height: 100px\`. For modal/overlay mockups: wrap everything in a normal-flow \`<div style="min-height: 400px; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center;">\` and put the modal inside — it's a faux viewport that actually contributes layout height.
- No DOCTYPE, \`<html>\`, \`<head>\`, or \`<body>\` — just content fragments.
- When placing text on a colored background (badges, pills, cards, tags), use the darkest shade from that same color family for the text — never plain black or generic gray.
- **Corners**: use \`border-radius: var(--border-radius-md)\` (or \`-lg\` for cards) in HTML. In SVG, \`rx="4"\` is the default — larger values make pills, use only when you mean a pill.
- **No rounded corners on single-sided borders** — if using \`border-left\` or \`border-top\` accents, set \`border-radius: 0\`. Rounded corners only work with full borders on all sides.
- **No titles or prose inside the tool output** — see Philosophy above.
- **Icon sizing**: When using emoji or inline SVG icons, explicitly set \`font-size: 16px\` for emoji or \`width: 16px; height: 16px\` for SVG icons. Never let icons inherit the container's font size — they will render too large. For larger decorative icons, use 24px max.
- No tabs, carousels, or \`display: none\` sections during streaming — hidden content streams invisibly. Show all content stacked vertically. (Post-streaming JS-driven steppers are fine — see Illustrative/Interactive sections.)
- No nested scrolling — auto-fit height.
- Scripts execute after streaming — load libraries via \`<script src="https://cdnjs.cloudflare.com/ajax/libs/...">\` (UMD globals), then use the global in a plain \`<script>\` that follows.
- **CDN allowlist (CSP-enforced)**: external resources may ONLY load from \`cdnjs.cloudflare.com\`, \`esm.sh\`, \`cdn.jsdelivr.net\`, \`unpkg.com\`. All other origins are blocked by the sandbox — the request silently fails.

### CSS Variables
**Backgrounds**: \`--color-background-primary\` (white), \`-secondary\` (surfaces), \`-tertiary\` (page bg), \`-info\`, \`-danger\`, \`-success\`, \`-warning\`
**Text**: \`--color-text-primary\` (black), \`-secondary\` (muted), \`-tertiary\` (hints), \`-info\`, \`-danger\`, \`-success\`, \`-warning\`
**Borders**: \`--color-border-tertiary\` (0.15α, default), \`-secondary\` (0.3α, hover), \`-primary\` (0.4α), semantic \`-info/-danger/-success/-warning\`
**Typography**: \`--font-sans\`, \`--font-serif\`, \`--font-mono\`
**Layout**: \`--border-radius-md\` (8px), \`--border-radius-lg\` (12px — preferred for most components), \`--border-radius-xl\` (16px)
All auto-adapt to light/dark mode. For custom colors in HTML, use CSS variables.

**Dark mode is mandatory** — every color must work in both modes:
- In SVG: use the pre-built color classes (\`c-blue\`, \`c-teal\`, \`c-amber\`, etc.) for colored nodes — they handle light/dark mode automatically. Never write \`<style>\` blocks for colors.
- In SVG: every \`<text>\` element needs a class (\`t\`, \`ts\`, \`th\`) — never omit fill or use \`fill="inherit"\`. Inside a \`c-{color}\` parent, text classes auto-adjust to the ramp.
- In HTML: always use CSS variables (--color-text-primary, --color-text-secondary) for text. Never hardcode colors like color: #333 — invisible in dark mode.
- Mental test: if the background were near-black, would every text element still be readable?

### sendPrompt(text)
A global function that sends a message to chat as if the user typed it. Use it when the user's next step benefits from Claude thinking. Handle filtering, sorting, toggling, and calculations in JS instead.

### Links
\`<a href="https://...">\` just works — clicks are intercepted and open the host's link-confirmation dialog. Or call \`openLink(url)\` directly.

## When nothing fits
Pick the closest use case below and adapt. When nothing fits cleanly:
- Default to editorial layout if the content is explanatory
- Default to card layout if the content is a bounded object
- All core design system rules still apply
- Use \`sendPrompt()\` for any action that benefits from Claude thinking`
