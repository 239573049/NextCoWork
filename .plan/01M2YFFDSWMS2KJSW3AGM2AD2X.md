# 免 Key 的「内置搜索」兜底

## 0. 需求一句话

用户一个搜索服务都没配（或配了但全挂）时，`web_search` 现在直接返回
「去 设置 › 连接 › 搜索 配 Key」的拒绝。改成：先用一条**不需要任何 Key** 的内置链路
去真的搜一次，搜不到再拒绝。

## 1. 现状（已在代码里核实）

| 事实 | 位置 |
|---|---|
| `searchChain` 过滤条件是 `enabled && hasKey && usable` —— 没 Key 一定不进链 | `src/shared/domain/search.ts:193` |
| 链为空时 `runSearch` 返回 `{results: [], failures: []}` | `src/main/search/service.ts:116-150` |
| 工具按 `failures.length === 0` 输出那句「没有配置搜索服务」 | `src/main/kernel/tool/builtin/web-search.ts:97` |
| 适配器签名强制要 `apiKey: string` | `src/main/search/types.ts:28` |
| `harvest.ts` 是零 import 的纯函数，只吃已解析的 JSON | `src/main/search/harvest.ts` |
| HTML→纯文本、textual content-type 白名单，目前私有在 WebFetch 里 | `src/main/kernel/tool/builtin/web.ts:49,84` |
| SSRF 字面量闸 + DNS 闸，会拦掉 `localhost` / `192.168.*` / 单标签主机名 | `src/main/kernel/tool/builtin/ssrf.ts:138,170` |
| 适配器统一经 `withUserAgent(host.fetch)`，于是代理设置自动生效 | `src/main/search/adapters/http.ts:47` |
| 设置页是 `SearchPane`，目前签名为 `(): ReactNode`，无 props | `src/renderer/src/settings/pages/connection/SearchPane.tsx:45` |
| `AppSettings` 是主进程唯一权威，页面靠 `SettingsPageProps.patch` 写 | `src/renderer/src/settings/props.ts` |

## 2. 已确认的决策

1. **兜底分两层**：① 公共 / 自建 SearxNG（JSON 接口）→ 全挂后 ② 直抓引擎 HTML，顺序固定
   **Bing → DuckDuckGo → 百度**。
2. **实例来源**：代码内置一份公共实例列表；用户可在设置里填一个自建实例 URL，**自建优先于内置**。
3. **触发条件**：付费链为空 **或** 付费链全部失败（含 401 / 超时 / 零结果）。
4. **深度**：SERP 列表 + 对**前 2 条**抓正文补摘要，正文阶段总预算 **6 秒**。
5. **告知方式**：结果文本里注明「来自内置免费源（实例域名）」，**不弹窗**；内置源**不进优先级链 UI**，
   设置页只在底部加一个说明 + 自建实例输入框的小节。
6. **SSRF**：用户手填的自建实例 URL **完全放宽**（含 `localhost` / 局域网 / 单标签主机名）。
   见 §7，这是本方案唯一一处破坏既有不变式的地方。

## 3. 架构落位（AGENTS §11 的四问）

- **放哪一层**：内置源是「搜索」的一种来源 → 全部住在 `src/main/search/builtin/**`，
  由 `search/service.ts` 唯一调用。纯解析逻辑（SERP HTML → 条目、HTML → 文本）抽成无 IO 的纯函数，
  与 `harvest.ts` 同款，便于穷举测。
- **谁拥有状态**：自建实例 URL 属于 `AppSettings`（主进程权威），不新建表、不进 `credentials`
  （它不是密钥）。内置实例列表是编译进包的常量，与 `SEARCH_CATALOG` 同款。
- **失败谁负责**：内置链路内部**不抛**，把每一步失败收集成 `failures` 交回 `runSearch`；
  翻译成用户/模型能读的话只发生在 `web-search.ts` 一处。设置页的「测试」按钮走 `tryInvoke`，
  照 `testSearchProvider` 的先例。
- **怎么被测**：解析层（SearxNG JSON、三家 SERP HTML、HTML→文本）是纯函数，喂固定样本；
  编排层（两层顺序、预算、触发条件）用假 `fetch` 注入测，全程不联网。

## 4. 文件清单

### 4.1 新增

| 文件 | 内容 | 约行数 |
|---|---|---|
| `src/shared/text/html-text.ts` | 从 `web.ts` **原样搬出** `htmlToText` / `isTextual` / `ENTITIES`。纯函数、零 import，渲染层也能引。**行为一个字不改**，只是换了住处，并在文件头写清「为什么搬：WebFetch 和内置搜索的正文抽取必须是同一份，两份会分叉」 | ~90 |
| `src/main/search/builtin/instances.ts` | 内置公共 SearxNG 实例常量表（每条带 `url` + 核对日期注释）+ `searxngCandidates(selfHosted)` 纯函数（自建在前、内置随后、去重） | ~60 |
| `src/main/search/builtin/searxng.ts` | 调一个实例：`GET {base}/search?q=…&format=json&language=…&safesearch=0`，非 2xx / 非 JSON / 零结果一律抛，成功经 `harvestAll` 归一 | ~80 |
| `src/main/search/builtin/serp.ts` | **纯函数**：三家 SERP HTML → `HarvestedItem[]`。每家一个解析函数 + 一张 `ENGINES` 数据表（`{id, buildUrl(query,count), parse(html)}`），新增一家是往表里加一行 | ~180 |
| `src/main/search/builtin/enrich.ts` | 对前 N 条抓正文：`host.fetch` → content-type 白名单 → `htmlToText` → 截断，失败静默跳过（保留原 snippet）。带总预算 `AbortController` | ~90 |
| `src/main/search/builtin/index.ts` | `runBuiltinSearch(query, count, deps)`：SearxNG 候选轮询 → 全挂则按 Bing→DDG→百度 直抓 → 命中后 `enrich` → 返回 `{results, sourceLabel, failures}` | ~120 |
| `src/main/search/builtin/__tests__/serp.test.ts` | 三家 SERP 样本 HTML 的解析断言 + 结构变化时的降级断言 | ~120 |
| `src/main/search/builtin/__tests__/builtin.test.ts` | 假 fetch 驱动：SearxNG 通 / SearxNG 全挂退到直抓 / 全挂 / 预算超时只丢正文不丢结果 / 中断立刻停手 | ~150 |
| `src/renderer/src/settings/pages/connection/BuiltinSearchSection.tsx` | 设置页底部小节：说明文字 + 自建实例 URL 输入 + 「测试」按钮 + 结果行 | ~120 |
| `src/renderer/src/i18n/builtin-search.ts` | 该小节的全部文案，导出 `builtinSearchZh` / `builtinSearchEn`（照 `git.ts` 先例，**不往 `index.tsx` 堆**） | ~40 |

### 4.2 修改（最小 diff）

| 文件 | 改什么 |
|---|---|
| `src/shared/domain/search.ts` | 新增 `export type SearchSourceId = SearchProviderId \| 'builtin'`；`SearchResult.provider` 与失败项的 id 放宽到 `SearchSourceId`。**`SEARCH_CATALOG` / `SEARCH_PROVIDER_IDS` / `defaultProviderConfigs` 一个字不改** —— 内置源不是一行可排序的 provider，混进目录会让它出现在设置列表、写进库、还要一个不存在的 Key 输入框 |
| `src/shared/domain/settings.ts` | `AppSettings` 增加 `builtinSearch: { searxngUrl: string }`（空串 = 未填）；`mergeSettings` 按既有嵌套块写法处理；默认值空串 |
| `src/main/kernel/tool/builtin/web.ts` | 删掉本地的 `htmlToText` / `isTextual` / `ENTITIES`，改为从 `shared/text/html-text.ts` import。**保留原有注释并在文件头补一句「实现已搬到 …，理由见那边」**（AGENTS §10.2：不删别人的理由） |
| `src/main/search/service.ts` | `runSearch` 末尾：付费链没出结果时调 `runBuiltinSearch`；`SearchOutcome` 增加 `sourceLabel?: string`（内置源用的实例/引擎名，付费源不填）。既有那条「空结果也切下一家」的注释与行为不动 |
| `src/main/kernel/tool/builtin/web-search.ts` | ① 结果头部注明来源；② 内置源命中时追加一句给模型看的可信度提示；③ 三种零结果文案（谁都没配 + 内置也失败 / 配了全挂 + 内置也失败 / 内置搜了但真没结果）；④ 工具 description 增补一行「无需配置也能用，但内置源质量较低」 |
| `src/main/ipc/websearch.ts` | 新增 `testBuiltinSearch()`：真跑一次 `runBuiltinSearch('hello', 1)`，**只回通不通 + 用了哪个源**，不回结果（沿用 `testProvider` 文件头那条「不给绕过工具链的搜索入口」的理由） |
| `src/shared/ipc/contract.ts` | 登记 `'websearch:testBuiltin': { req: void; res: { ok: boolean; latencyMs?: number; source?: string; message?: string } }`，并在底部两张版本表各加一行 |
| `src/main/ipc/index.ts` | 挂上该 handler（照 `websearch:test` 的写法） |
| `src/renderer/src/services/websearch.ts` | 加 `testBuiltinSearch()`，用 `tryInvoke`（失败是要显示的结果，不是要吞的异常） |
| `src/renderer/src/settings/pages/connection/SearchPane.tsx` | 签名改为 `(props: SettingsPageProps)`，在既有 `SettingGroup` 之后渲染 `<BuiltinSearchSection …/>`。**其余一行不动**（该文件是双引号+分号风格，新加的行跟随它） |
| `src/renderer/src/settings/pages/ConnectionPage.tsx` | `case 'search': return <SearchPane {...props} />` |
| `src/renderer/src/i18n/index.tsx` | 只加两处 spread（`...builtinSearchZh` / `...builtinSearchEn`）。**不往那 3900 行里加 key** |

## 5. 行为规格

### 5.1 触发

```
runSearch(query, count):
  付费链（searchChain）依次尝试            ← 现有逻辑，不动
  若拿到结果 → 原样返回（含中途 failures）  ← 现有逻辑，不动
  否则（链为空 或 全部失败）→ runBuiltinSearch(...)
      命中 → { results, provider: 'builtin', sourceLabel, failures: 付费链的失败 + 内置层的失败 }
      未命中 → { results: [], failures: 两层的全部失败 }
```

★ 付费链的 `failures` **必须一起带回去**，即使内置源救回了结果——否则用户那个过期的 Tavily Key
会永远坏下去，而表面上「搜索还能用」。这与 `service.ts:54-59` 既有注释是同一条理由。

### 5.2 内置链路内部

1. **SearxNG 层**：候选 = `[自建URL(若非空), …内置实例]`，逐个试，**每个 4 秒超时**，最多试 3 个。
   判成功 = HTTP 2xx + JSON 可解析 + `harvestAll` 后条目 > 0。任一条不满足 → 记一笔 failure 换下一个。
2. **直抓层**（SearxNG 全挂才进）：固定顺序 Bing → DuckDuckGo → 百度，每家 **5 秒超时**，
   `accept: text/html`、带 `withUserAgent` 的 UA。判成功同上（解析后条目 > 0）。
   识别到验证码页 / `HTTP 202 / 403` → 记 failure 换下一家，不重试同一家。
3. **正文补全**：对前 2 条并发抓取，**总预算 6 秒**，单条 content-type 非文本或超时就跳过，
   保留原 snippet；成功则把正文截到 800 字符替换 snippet。
   ★ 正文阶段**永不影响主结果**：哪怕 2 条全失败，SERP 列表照常返回。
4. 全程尊重外层 `signal`：用户点停止时立刻抛，不把剩下的候选跑完（照抄
   `service.ts:139-142` 那条 `★` 的处理方式）。

### 5.3 交给模型的文本

命中内置源时，结果头部为：

```
Search results for "…" (via built-in free source: searx.example.org):

1. …
```

并在末尾追加一句固定说明：这些结果来自无需配置的免费源，质量与时效低于用户配置的专业搜索服务；
需要准确内容时用 `WebFetch` 打开原文。**这句话同时就是对用户的告知**（决策 5：不弹窗）。

全失败时的文案分三种，因为模型接下来该做的事不同：

| 情况 | 说什么 |
|---|---|
| 没配任何服务 + 内置源也失败 | 「内置免费源这次也没能用（原因逐条列出）。请用户去 设置 › 连接 › 搜索 配一个服务，或在那一页填自建 SearxNG 实例。」 |
| 配了但全挂 + 内置源也失败 | 先列付费源各自的原话（Key/额度问题在这里暴露），再列内置源的失败 |
| 内置源通了但零结果 | 「搜索正常，这个查询没有结果」—— 换查询词是有意义的，不能和上面混为一谈 |

### 5.4 设置页小节

位于「设置 › 连接 › 搜索」列表**下方**，不占列表行、不参与拖拽排序：

- 标题 + 一段说明：不配任何服务时会自动使用内置免费源；查询词会发送给公共实例；质量低于专业服务。
- 一个文本框：自建 SearxNG 实例地址（可空）。失焦/回车经 `patch({ builtinSearch: { searxngUrl } })` 落库。
- 一个「测试」按钮：调 `websearch:testBuiltin`，显示「可用 · 123ms · 来源 xxx」或失败原话。
- **没有开关**（决策：隐形兜底）。留空输入框即回到纯内置实例。

## 6. 数据与兼容

- **无数据库迁移**：新字段住在 `AppSettings`（`settings` 那张既有的 JSON 型设置里），
  旧配置读出来缺这个键时由 `mergeSettings` 的默认值补成 `{ searxngUrl: '' }`。
- 需核对 `src/shared/domain/config-sync.ts`：若 `AppSettings` 整体参与配置同步，
  `builtinSearch.searxngUrl` 应与 `shell` 同类标为**本机字段**（自建实例多半是 `localhost`，
  同步到另一台机器就是个死地址）。实现时先读那个文件的既有分类方式再决定，不臆造新机制。
- 向后兼容：已配置了搜索服务的用户**行为完全不变**（付费链命中就直接返回，根本不进内置层）。

## 7. ★ 破坏既有不变式的一处：自建实例放宽 SSRF

现有 `ssrfRisk` 会拒绝 `localhost` / `127.0.0.1` / `192.168.*` / 单标签主机名，
而自建 SearxNG 最常见的形态恰恰是 `http://localhost:8080`。按决策，**用户手填的那个 URL 完全放宽**。

实现约束（三条都要写进代码注释）：

1. 放宽**只作用于 `settings.builtinSearch.searxngUrl` 这一个值**，
   且该值只能由设置页写入。模型、网页、Skill、MCP 都碰不到它。
   `WebFetch` / `browser_*` 的闸一律不动。
2. 内置实例列表照常过 `ssrfRisk`（它们是代码里的常量，但万一有人改错，这道闸还在）。
3. 请求用 `redirect: 'manual'`，**不跟随跳转**；响应只按 JSON 解析，非 JSON 直接判失败。
   这样即便那个地址指向内网的某个服务，泄露面也仅限于「查询词发过去 + 响应必须是搜索结果形状的 JSON」。

风险如实记：用户如果把一个内网地址填错成别的内网服务，查询词会发给它。
这是用户自己输入地址的后果，与「模型构造地址」是两件事——SSRF 防的是后者。

## 8. 边界情况

- **离线**：三层全部网络错，走 §5.3 的失败文案，不抛异常、不留悬挂的定时器（`timer.unref()`，照 `service.ts:88`）。
- **公共实例限流（429）**：算一次 failure 换下一个候选，不退避重试（一次搜索里重试只会把延迟翻倍）。
- **SearxNG 实例禁用了 `format=json`**（很常见，返回 HTML 或 403）：非 JSON 即失败换下一个。
  这就是「两层」存在的全部理由，注释里要写明。
- **SERP 结构改版**：解析器取不到条目 → 零结果 → 换下一家；三家都零结果时，
  failure 文案要能区分「被挡」和「解析不出来」，否则半年后没人知道该修哪儿。
- **百度结果里的跳转链接**（`baidu.com/link?url=…`）：不解跳转（要多一次请求），
  原样交给模型，由 `WebFetch` 跟随。注释写清这是有意为之。
- **查询词含 CJK**：URL 编码统一用 `URLSearchParams`，不手拼。
- **中断**：外层 `signal` 已 abort 时立刻抛，正文补全阶段同样。
- **重复 URL**：`harvestAll` 已按 url 去重；两层之间不会混用结果（命中一层就返回）。

## 9. 需求注释要求（AGENTS §10.1）

每个新文件的文件头第一段必须写明：为了什么需求建、持有哪条不变式、故意不做什么。至少覆盖：

- `builtin/index.ts`：为什么是「两层」而不是只做 SearxNG；为什么不做重试退避；为什么不缓存结果。
- `builtin/serp.ts`：为什么是解析 SERP HTML 而不是用浏览器（首次要下载 Chromium、慢一个数量级）；
  为什么引擎是一张表而不是 if-else 链。
- `builtin/enrich.ts`：为什么正文失败不算整体失败；为什么预算是硬上限。
- `shared/text/html-text.ts`：为什么从 `web.ts` 搬出来（两份会分叉），以及它**不是** markdown 转换器。
- `instances.ts`：每条实例带核对日期；写明「实例挂了要发版才能换」这个已知代价。

## 10. 验证

```bash
npm run typecheck        # 主进程 + 渲染层都动了
npm run typecheck:web
npm test                 # 新增两个测试文件 + i18n 键一致性校验
npm run lint
```

手动验证清单：

1. 清空所有搜索服务 Key → 问一个需要联网的问题 → 应当真的搜到结果，且结果里标着内置来源。
2. 配一个故意写错的 Tavily Key 并启用 → 搜索仍应有结果，且结果末尾能看到 Tavily 的失败原话。
3. 设置页填一个本机 SearxNG（`http://localhost:8080`）→ 点测试 → 应显示可用；
   清空后再测 → 应回落到内置实例。
4. 断网 → 搜索应给出「内置源也失败」的完整原因，且界面不卡住、进程能正常退出。
5. 搜索进行中点停止 → 立刻停，不把剩余候选跑完。

## 11. 不做的事（本次明确排除）

- 不把内置源做成设置列表里的第 9 行、不给它开关和优先级（决策：隐形兜底）。
- 不引入 headless 浏览器抓 SERP（首次下载 Chromium 的代价与「零配置即可用」的目标相反）。
- 不从 `searx.space` 运行时拉实例列表（多一个网络依赖和一份缓存）；
  实例失效的应对方式是发版更新列表 + 用户填自建实例。
- 不做结果缓存、不做查询改写、不做重试退避。
- 不碰 `SEARCH_CATALOG` 里 `doubao` / `bing` 的 `unavailable` 结论。
- 不顺手修 AGENTS §15 里记的任何既有技术债。
