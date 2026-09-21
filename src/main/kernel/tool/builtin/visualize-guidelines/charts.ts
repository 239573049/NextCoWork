/**
 * visualize read_me 的 `Chart.js` 模块规范 —— 逐字取自 Anthropic 的 `visualize:read_me` 响应。
 *
 * 需求:图表：canvas 尺寸、自定义图例、数字格式。模型在写 widget 之前先读它,而不是每次从零试错 ——
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

export const CHARTS_CHART_JS = `## Charts (Chart.js)
\`\`\`html
<div style="position: relative; width: 100%; height: 300px;">
  <canvas id="myChart"></canvas>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js" onload="initChart()"></script>
<script>
  function initChart() {
    new Chart(document.getElementById('myChart'), {
      type: 'bar',
      data: { labels: ['Q1','Q2','Q3','Q4'], datasets: [{ label: 'Revenue', data: [12,19,8,15] }] },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }
  if (window.Chart) initChart();
</script>
\`\`\`

**Chart.js rules**:
- Canvas cannot resolve CSS variables. Use hardcoded hex or Chart.js defaults.
- Wrap \`<canvas>\` in \`<div>\` with explicit \`height\` and \`position: relative\`.
- **Canvas sizing**: set height ONLY on the wrapper div, never on the canvas element itself. Use position: relative on the wrapper and responsive: true, maintainAspectRatio: false in Chart.js options. Never set CSS height directly on canvas — this causes wrong dimensions, especially for horizontal bar charts.
- For horizontal bar charts: wrapper div height should be at least (number_of_bars * 40) + 80 pixels.
- Load UMD build via \`<script src="https://cdnjs.cloudflare.com/ajax/libs/...">\` — sets \`window.Chart\` global. Follow with plain \`<script>\` (no \`type="module"\`).
- **Script load ordering**: CDN scripts may not be loaded when the next \`<script>\` runs (especially during streaming). Always use \`onload="initChart()"\` on the CDN script tag, define your chart init in a named function, and add \`if (window.Chart) initChart();\` as a fallback at the end of your inline script. This guarantees charts render regardless of load order.
- Multiple charts: use unique IDs (\`myChart1\`, \`myChart2\`). Each gets its own canvas+div pair.
- For bubble and scatter charts: bubble radii extend past their center points, so points near axis boundaries get clipped. Pad the scale range — set \`scales.y.min\` and \`scales.y.max\` ~10% beyond your data range (same for x). Or use \`layout: { padding: 20 }\` as a blunt fallback.
- Chart.js auto-skips x-axis labels when they'd overlap. If you have ≤12 categories and need all labels visible (waterfall, monthly series), set \`scales.x.ticks: { autoSkip: false, maxRotation: 45 }\` — missing labels make bars unidentifiable.

**Number formatting**: negative values are \`-$5M\` not \`$-5M\` — sign before currency symbol. Use a formatter: \`(v) => (v < 0 ? '-' : '') + '$' + Math.abs(v) + 'M'\`.

**Legends** — always disable Chart.js default and build custom HTML. The default uses round dots and no values; custom HTML gives small squares, tight spacing, and percentages:

\`\`\`js
plugins: { legend: { display: false } }
\`\`\`

\`\`\`html
<div style="display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 8px; font-size: 12px; color: var(--color-text-secondary);">
  <span style="display: flex; align-items: center; gap: 4px;"><span style="width: 10px; height: 10px; border-radius: 2px; background: #3266ad;"></span>Chrome 65%</span>
  <span style="display: flex; align-items: center; gap: 4px;"><span style="width: 10px; height: 10px; border-radius: 2px; background: #73726c;"></span>Safari 18%</span>
</div>
\`\`\`

Include the value/percentage in each label when the data is categorical (pie, donut, single-series bar). Position the legend above the chart (\`margin-bottom\`) or below (\`margin-top\`) — not inside the canvas.

**Dashboard layout** — wrap summary numbers in metric cards (see UI fragment) above the chart. Chart canvas flows below without a card wrapper. Use \`sendPrompt()\` for drill-down: \`sendPrompt('Break down Q4 by region')\`.`
