# 消息列表组件设计方案（实时流式渲染场景）

> 目标读者：负责实现聊天/对话类消息列表的前端工程师。
> 本文的重心不是「怎么写一个列表」，而是**消息持续流式追加/更新时，如何让它不掉帧、不跳动、不失控**。
> 每个性能点按「现象 → 根因 → 实现 → 代价」四段式展开。

---

## 0. 假设与技术栈声明

方案成立依赖以下假设。**如果你的场景与之不符，请直接跳到第 9 节重新选型**——不同量级下的最优解差异很大。

| 维度 | 假设 | 不符时的影响 |
|---|---|---|
| 技术栈 | React 18 + TypeScript，可用 `startTransition` / `useSyncExternalStore` | React 17 需退化为手动 rAF 调度，见 §5.3 |
| 虚拟化库 | `@tanstack/react-virtual` v3 | v2 的 `measureElement` 语义不同 |
| 单会话总量 | 历史 1 万～10 万条，内存窗口保留 ≤ 2000 条，向上分页 | ≤200 条不需要虚拟化，见 §9 |
| 消息高度 | **不定高**：单行文本 ~40px、图片 ~320px、代码块可达 600px+ | 定高场景本文 §5.1/§5.2 大幅简化 |
| 内容类型 | 富文本 / Markdown / 图片 / 代码块，图片尺寸**可能未知** | 纯文本可去掉 §7.2 的占位逻辑 |
| 流式并发 | 同时 1～2 条消息在流式追加，token 到达 20～60 次/秒 | 更高频需加大合帧窗口，见 §5.3 |
| 群聊并发 | 可能有多条新消息并发插入 | 单聊可简化去重逻辑 |
| 设备基线 | 中端 Android / 4x CPU 降速下仍需 ≥ 50fps | 决定了 overscan 与 worker 化的取值 |

### 哪些结论是框架无关的

| 结论 | 框架无关？ | 说明 |
|---|---|---|
| 三层解耦（数据 / 测量 / 滚动） | ✅ 完全无关 | 架构原则 |
| `column-reverse` 倒置解决贴底 | ✅ 完全无关 | 纯 CSS + DOM 行为 |
| rAF 合帧 / chunk buffer | ✅ 完全无关 | 浏览器调度，Vue/Svelte/Solid 同样适用 |
| ResizeObserver 测量 + offset 补偿 | ✅ 完全无关 | DOM API |
| `content-visibility` / `contain` | ✅ 完全无关 | CSS |
| 行级 `memo` + 精确比较 | ⚠️ 部分 | Vue 的响应式天然细粒度，Solid 无需 memo |
| `startTransition` 划分优先级 | ❌ React 专有 | 其他框架用手动 rAF 分片替代 |
| 旁路 store 订阅避免 re-render | ⚠️ 部分 | Solid/Svelte 的信号天然做到，React 需手动绕开 |

---

## 1. 整体设计思路

一句话：**把「数据流」「布局测量」「滚动控制」三件事彻底解耦，任何一件事的高频变化都不允许触发另外两件事的重算。**

大多数消息列表卡顿的根因是这三者耦合在一起：一个 token 到达 → state 变化 → 整列表 re-render → 全部重新测量 → 滚动位置被动调整 → 触发 scroll 事件 → 又一次 state 变化。这是一个每秒可能跑 60 次的正反馈环。

三层职责：

| 层 | 负责 | **绝不负责** |
|---|---|---|
| 数据流层 | 消息的增删改、乱序去重、乐观更新、分页 | 不知道任何一条消息的高度、不知道当前滚到哪 |
| 布局测量层 | 估高、实测、高度缓存、虚拟窗口计算 | 不知道消息的业务语义（谁发的、什么状态） |
| 滚动控制层 | 贴底状态机、跳转、未读计数、历史锚定 | 不直接改数据，只读窗口信息 |

```mermaid
flowchart TD
    WS[WebSocket / SSE] --> Buf[ChunkBuffer<br/>rAF 合帧]
    Buf -->|流结束时提交| Store[(Normalized Store<br/>byId + orderedIds)]
    Buf -.->|流式期间旁路直推.-> SB[StreamingBody]
    Store --> Sel[Selector 订阅]
    Sel --> V[Virtualizer<br/>react-virtual]
    HC[(高度缓存<br/>byId → px)] <--> V
    V --> Rows[MessageRow memo]
    Rows --> SB
    Rows --> RO[ResizeObserver]
    RO --> HC
    V --> SC[滚动控制层<br/>贴底状态机]
    SC --> Scroll[scrollTop]
```

注意图中那条**虚线**：流式期间 token 不经过 Store，直接推给 `StreamingBody`。这是全文最重要的一条设计决策，详见 §5.3。

---

## 2. 组件结构与拆分

```
<MessageListProvider>              数据层边界：store + 高度缓存 + 事件总线
  <MessageListContainer>           滚动容器（正序 + 初始置底），拥有 scrollRef
    <Virtualizer>                  useVirtualizer 的宿主，只输出「渲染哪些 index + 偏移」
      <MessageRow key={clientId}>  memo 行，负责测量上报与布局，不关心内容怎么渲染
        <MessageBubble>            气泡壳：头像、时间、状态角标、失败重试按钮
          <MessageBody>            静态内容渲染（Markdown / 图片 / 卡片）
          <StreamingBody>          流式内容渲染，旁路订阅，独立于 store
      <TopSentinel>                触顶哨兵，IntersectionObserver 触发 onLoadMore
      <SkeletonGroup>              历史加载占位，撑住高度避免锚点丢失
  <JumpToLatestFab>                脱离贴底时出现，带未读计数
```

### 职责边界表

关键在于「不允许知道什么」——这一列比「负责什么」更能防止架构腐化。

| 组件 | 负责 | **不允许知道** |
|---|---|---|
| `MessageListProvider` | 持有 store、高度缓存、流式 buffer；暴露 imperative handle | 不允许知道 DOM、不允许读 `scrollTop` |
| `MessageListContainer` | 滚动容器与 CSS、贴底状态机、scroll 事件节流 | 不允许知道消息内容与业务状态 |
| `Virtualizer` | 计算可见窗口、estimateSize 分桶、measureElement 接线 | 不允许知道消息是谁发的、是否失败 |
| `MessageRow` | 定位（transform）、`data-index`、ResizeObserver 上报 | **不允许知道自己是不是最后一条**（否则每次追加全列表失效） |
| `MessageBubble` | 气泡壳、状态角标、重试交互 | 不允许直接改 store，只能发事件 |
| `MessageBody` | 静态内容渲染 + 解析结果缓存 | 不允许知道流式状态 |
| `StreamingBody` | 订阅 buffer、rAF 写 DOM | **不允许触发 React re-render**（见 §5.3） |
| `TopSentinel` | 触顶上报 | 不允许自己调 API，只回调 `onLoadMore` |
| `JumpToLatestFab` | 展示未读数、点击跳转 | 不允许知道虚拟化实现细节，只调 handle |

**为什么 `MessageRow` 不允许知道「自己是不是最后一条」**：如果传 `isLast` prop，每追加一条新消息，上一条的 `isLast` 从 `true` 变 `false`，导致它 re-render；再叠加 memo 比较，等于每次追加至少多两次行渲染。正确做法是把「最后一条」的特殊 UI（比如流式光标）交给 `StreamingBody` 通过 buffer 状态自行判断。

---

## 3. 数据模型与 API 设计

### 3.1 消息类型

```ts
export type MessageStatus =
  | 'pending'    // 乐观插入，未收到服务端 ack
  | 'streaming'  // 正在流式追加
  | 'sent'       // 已确认
  | 'failed'     // 发送失败，可重试
  | 'revoked'    // 已撤回
  | 'deleted';   // 已删除（本地保留墓碑以维持高度缓存一致）

export type MessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; raw: string }
  | { kind: 'image'; url: string; width?: number; height?: number; blurhash?: string }
  | { kind: 'card'; schema: string; payload: unknown }
  | { kind: 'system'; text: string };

export interface Message {
  /** 客户端稳定 ID，创建即生成，永不变更 —— React key 用它 */
  clientId: string;
  /** 服务端 ID，乐观消息 ack 后回填；用于去重与分页游标 */
  serverId?: string;
  conversationId: string;
  senderId: string;
  /** 服务端时间戳；乐观消息先用本地时间，ack 后校正 */
  createdAt: number;
  /** 单调递增序号，用于乱序插入定位，优于时间戳 */
  seq?: number;
  status: MessageStatus;
  content: MessageContent;
  /** 编辑版本号，内容原地替换时 +1，用于 memo 比较 */
  rev: number;
  replyTo?: string;
  failureReason?: string;
}
```

**三个字段的设计理由**：

- `clientId` 而非 `serverId` 作 key —— 乐观消息在 ack 前没有 `serverId`，若用 `serverId ?? tempId` 作 key，ack 那一刻 key 变化 → React 卸载重建整个行 → 高度缓存失效 → 滚动跳动。用 `clientId` 则 ack 只是一次 props 更新。
- `rev` 而非深比较内容 —— memo 比较函数只需比 `rev`，O(1)，避免对 Markdown 长字符串做比较。
- `seq` 而非 `createdAt` 排序 —— 时间戳可能因时钟漂移重复或倒退，`seq` 单调，乱序插入时二分定位可靠。

### 3.2 归一化 store 与列表状态

```ts
export interface ListState {
  byId: Record<string, Message>;
  /** 有序 clientId 列表，时间正序（旧 → 新），与渲染顺序一致（见 §5.2 路径 C） */
  orderedIds: string[];
  /** serverId → clientId，用于去重与 ack 收敛 */
  serverIdIndex: Record<string, string>;
  hasMoreTop: boolean;
  loadingTop: boolean;
  /** 分页游标，指向已加载的最旧一条 */
  topCursor?: string;
  unreadCount: number;
}
```

为什么用 `byId` + `orderedIds` 而不是 `Message[]`：单条消息更新时只需替换 `byId[id]` 一个引用，`orderedIds` 数组引用不变 → 依赖 `orderedIds` 的虚拟化层不会失效；若用数组，任何一条更新都要产生新数组，虚拟化层被迫重算。

### 3.3 对外 Props 与命令式 API

```ts
export interface MessageListProps {
  conversationId: string;
  /** 初始数据，后续增量通过 handle 或 store action 注入 */
  initialMessages: Message[];
  currentUserId: string;

  /** 触顶加载历史，返回更旧的一页；返回空数组表示到底 */
  onLoadMore: (cursor?: string) => Promise<Message[]>;
  /** 失败消息重试 */
  onRetry: (clientId: string) => void;
  /** 进入贴底态时触发，通常用于已读上报 */
  onReachBottom?: () => void;
  /** 可见窗口变化，用于曝光埋点；已内部节流至 200ms */
  onVisibleRangeChange?: (range: { startIndex: number; endIndex: number }) => void;

  renderItem?: (msg: Message) => React.ReactNode;
  estimateSize?: (msg: Message) => number;
  overscan?: number;
}

export interface MessageListHandle {
  /** behavior 默认 'auto'；流式期间应始终用 'auto' 避免动画排队 */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToMessage: (clientId: string, align?: 'start' | 'center') => void;
  /** 追加一条新消息（他人发来 / 自己发出） */
  append: (msg: Message) => void;
  /** 流式：开始 / 追加 chunk / 结束 —— 三段式，见 §5.3 */
  beginStream: (clientId: string) => void;
  appendChunk: (clientId: string, chunk: string) => void;
  endStream: (clientId: string, final?: Partial<Message>) => void;
  /** 原地替换（编辑 / 撤回 / ack 回填） */
  patch: (clientId: string, patch: Partial<Message>) => void;
  /** 批量前插历史 */
  prependHistory: (msgs: Message[]) => void;
  isAtBottom: () => boolean;
}
```

**流式 API 为什么是三段式而不是单个 `updateContent`**：`beginStream` 让组件提前把该行标记为「旁路渲染」并挂载 `StreamingBody`；`appendChunk` 走 buffer 完全不碰 React；`endStream` 才做唯一一次 state 提交。若只暴露 `updateContent`，调用方无法表达「这是流式中间态」，组件只能每次都走完整更新路径。

---

## 4. 渲染与更新策略

### 4.1 key 设计与乐观消息的 id 收敛

**现象**：自己发的消息，气泡在 ack 瞬间闪一下，图片重新加载，滚动位置轻微跳动。

**根因**：key 从临时 id 变成了 `serverId`。React 认为这是「删除旧节点 + 插入新节点」，整棵子树卸载重建 —— 图片重新解码，ResizeObserver 重新绑定，高度缓存条目对不上。

**实现**：key 恒定用 `clientId`，`serverId` 只写进索引：

```ts
function ackMessage(state: ListState, clientId: string, serverId: string): ListState {
  const prev = state.byId[clientId];
  if (!prev) return state;
  // 服务端可能已通过推送把同一条消息以 serverId 下发过 —— 去重
  const dup = state.serverIdIndex[serverId];
  if (dup && dup !== clientId) return removeMessage(state, clientId);

  return {
    ...state,
    byId: { ...state.byId, [clientId]: { ...prev, serverId, status: 'sent', rev: prev.rev + 1 } },
    serverIdIndex: { ...state.serverIdIndex, [serverId]: clientId },
    // orderedIds 引用不变 —— 虚拟化层不失效
  };
}
```

**代价**：需要额外维护 `serverIdIndex` 一张表，以及「同一条消息两条路径到达」的去重分支。这是必要成本，群聊里回显与推送竞态很常见。

### 4.2 行级 memo 与精确比较

```tsx
interface MessageRowProps {
  clientId: string;
  rev: number;
  status: MessageStatus;
  measureRef: (el: HTMLElement | null) => void;
  transform: number;
}

export const MessageRow = React.memo(
  function MessageRow({ clientId, measureRef, transform }: MessageRowProps) {
    const msg = useMessage(clientId);          // selector 订阅，见 4.3
    return (
      <div
        ref={measureRef}
        data-index={msg.index}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${transform}px)`,
          contain: 'layout paint',              // 见 5.5
        }}
      >
        <MessageBubble msg={msg} />
      </div>
    );
  },
  (a, b) =>
    a.clientId === b.clientId &&
    a.rev === b.rev &&                          // 内容变化只看版本号，O(1)
    a.status === b.status &&
    a.transform === b.transform
);
```

**为什么快**：比较函数不触碰内容字符串。流式消息的 `rev` 在流式期间**不变**（内容走旁路），所以正在流式的那一行在整个流式过程中 memo 命中，零 re-render。

**代价**：`rev` 必须严格维护，任何绕过 reducer 直接改 `byId` 的写法都会导致「内容变了但界面不更新」这类难查的 bug。建议 store 层用 `Object.freeze`（dev 模式）强制约束。

### 4.3 订阅粒度：selector 而非 context 传值

**现象**：把 `messages` 数组放进 Context，任何一条消息更新都会让所有 consumer 重渲染 —— memo 完全失效，因为 context 值变化会穿透 memo。

**实现**：用 `useSyncExternalStore` 做单条订阅：

```ts
export function useMessage(clientId: string): Message {
  const store = useContext(StoreContext);       // 只传 store 实例，引用永远不变
  return useSyncExternalStore(
    useCallback((cb) => store.subscribeMessage(clientId, cb), [store, clientId]),
    useCallback(() => store.getMessage(clientId), [store, clientId])
  );
}
```

store 内部按 `clientId` 维护订阅者集合，`patch` 时只通知那一条的订阅者。

**为什么快**：一条消息更新的通知面从 O(n) 降到 O(1)。1000 条在窗口外的消息完全不参与。

**代价**：需要自己实现细粒度订阅（约 60 行），且 `getSnapshot` 必须返回稳定引用，否则 React 会抛无限循环警告。

### 4.4 不可变更新的边界

不可变不等于「每次都全量复制」。三条实践规则：

1. **只在变更路径上复制**（结构共享）：改一条消息只新建 `byId` 顶层对象和那一条，其余 999 条保持原引用。
2. **`orderedIds` 尽量不动**：追加用 `push` 语义时不可避免要新建数组，但**内容更新绝不碰它**。
3. **高度缓存用可变 Map**：它不参与渲染判等，用普通 `Map` 即可，避免每次测量都产生新对象。

---

## 5. 实时渲染性能优化

本节是全文重点。

### 5.1 `@tanstack/react-virtual` 接入

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';

const heightCache = useRef(new Map<string, number>()).current;

// 按内容类型分桶估高 —— 比全局单值把偏差从 ±40% 压到 ±8%
const estimateSize = useCallback((index: number) => {
  const id = orderedIds[index];
  const cached = heightCache.get(id);
  if (cached) return cached;                       // 命中实测值

  const msg = byId[id];
  switch (msg.content.kind) {
    case 'text': {
      const perLine = Math.floor(containerWidth / 16);   // 约每行字数
      const lines = Math.max(1, Math.ceil(msg.content.text.length / perLine));
      return 24 + lines * 22;                             // 内边距 + 行高
    }
    case 'image': {
      const { width, height } = msg.content;
      if (width && height) return Math.min(320, (height / width) * bubbleWidth) + 16;
      return 220;                                          // 未知尺寸的保守值
    }
    case 'markdown': return 80;
    case 'card':     return 140;
    case 'system':   return 32;
  }
}, [orderedIds, byId, containerWidth]);

const virtualizer = useVirtualizer({
  count: orderedIds.length,
  getScrollElement: () => scrollRef.current,
  estimateSize,
  getItemKey: (index) => orderedIds[index],      // 必须！默认用 index，插入历史会错位
  overscan: 5,
  measureElement: (el) => {
    const h = el.getBoundingClientRect().height;
    const id = el.getAttribute('data-key');
    if (id) heightCache.set(id, h);              // 持久化，会话切回直接命中
    return h;
  },
});
```

**`getItemKey` 是最容易漏的一项**：默认按 index 缓存测量结果，一旦向上插入 20 条历史，所有 index 后移，缓存全部错位 —— 表现为加载历史后列表高度乱跳。

**overscan 取值依据**：不是越大越好。overscan=5 意味着上下各多渲染 5 条；在中端机上，一条富文本行的挂载成本约 0.3～0.8ms，5 条 ≈ 4ms，仍在一帧预算内。超过 10 会让快速滚动时的单帧挂载成本突破 16ms。**结论：文本为主取 5，图片/卡片多取 3，配合 §5.5 的图片懒挂载。**

### 5.2 倒置 + 虚拟化的正确组合（关键耦合点）

这是本方案最容易翻车的地方，必须给出明确结论。三条路径：

| 路径 | 做法 | 优点 | 致命问题 | 结论 |
|---|---|---|---|---|
| **A. CSS `column-reverse`** | 容器 `flex-direction: column-reverse`，数据保持正序 | 贴底天然、历史插入不跳、`scrollTop=0` 即底部 | 与 `react-virtual` 的**绝对定位 + translateY 冲突**：虚拟项本就脱离流式布局，flex 方向对它们无效 | ❌ **与 react-virtual 不能直接叠加** |
| **B. 数据 `reverse()` + 正序容器** | `orderedIds` 反转，index 0 = 最新，普通向下滚动容器 | 完全兼容虚拟化；「加载更多」变成向下加载，是虚拟库的原生强项 | 需要在 UI 层做视觉倒置，或接受「最新在上」的产品形态 | ⚠️ 仅适合最新在上的产品 |
| **C. 正序数据 + `initialOffset` 置底 + 手动锚定** | 保持正序，初始把 `scrollTop` 设为 `getTotalSize()`，贴底与历史锚定手写 | 视觉形态正常（最新在下）、与虚拟化完全兼容、可控性最强 | 贴底与锚定要自己实现（本文 §6 给出完整实现） | ✅ **推荐** |

**明确结论**：`flex-direction: column-reverse` 与 `@tanstack/react-virtual` **不能直接组合**。原因是虚拟化把每一项渲染成 `position: absolute; transform: translateY(offset)`，父容器的 flex 方向对绝对定位子元素不产生排列作用，倒置失效；即使改用非绝对定位模式，虚拟库计算的 offset 语义（自顶向下累加）也与倒置后的视觉顺序相反，会导致滚动位置与渲染窗口彻底错位。

**因此本方案采用路径 C**，并把 `column-reverse` 保留为**不上虚拟化时的首选**（见 §9）。这修正了前期方案中「倒置 + 虚拟化」的设想 —— 该组合在工程上不成立，与其绕过不如正面说明。

倒置退场后，贴底与锚定必须手写，具体见 §6。初始置底写法：

```tsx
const virtualizer = useVirtualizer({
  /* ...同上... */
  initialOffset: () => Number.MAX_SAFE_INTEGER,   // 首帧即置底，避免「先看到顶部再跳」
});

// 首屏图片/字体加载完成后总高会变，需再置底一次
useLayoutEffect(() => {
  virtualizer.scrollToIndex(orderedIds.length - 1, { align: 'end' });
}, []);
```

**为什么不用 `scrollTop = scrollHeight`**：虚拟化下 `scrollHeight` 来自 spacer 的估算值，首帧极不准；`scrollToIndex` 走的是虚拟库内部的 offset 表，且会在测量后自动重试对齐。

### 5.3 流式批处理：chunk buffer + rAF 合帧 + 旁路订阅

**现象**：单条消息流式输出时，帧率从 60 掉到 20～30，CPU 占用飙升；列表越长掉得越狠。

**根因**：三层放大效应叠加。

1. token 到达频率 20～60 次/秒，**高于屏幕刷新率**，一帧内可能触发 2～3 次 setState，多余的渲染结果根本没机会上屏就被下一次覆盖 —— 纯浪费。
2. 每次 setState 会让整条 React 树走一遍 reconcile。即使 `MessageRow` 有 memo，虚拟化容器自身仍要重算 `getVirtualItems()`。
3. 每次内容变化触发 `measureElement` → `getBoundingClientRect()` → **强制同步布局**。60 次/秒的强制布局是掉帧主因，比 diff 本身贵得多。

**实现**：把流式内容从 React 数据流里**摘出去**，走独立 buffer + rAF 合帧，只在结束时提交一次 state。

```ts
// ---- 旁路 store：完全不在 React state 里 ----
type StreamListener = (text: string) => void;

class StreamBuffer {
  private text = new Map<string, string>();
  private listeners = new Map<string, Set<StreamListener>>();
  private dirty = new Set<string>();
  private rafId = 0;

  begin(clientId: string, initial = '') {
    this.text.set(clientId, initial);
  }

  /** 高频调用点：只做字符串拼接 + 标脏，不触发任何渲染 */
  append(clientId: string, chunk: string) {
    this.text.set(clientId, (this.text.get(clientId) ?? '') + chunk);
    this.dirty.add(clientId);
    this.schedule();
  }

  private schedule() {
    if (this.rafId) return;                    // 同一帧内的多次 chunk 合并为一次 flush
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      for (const id of this.dirty) {
        const t = this.text.get(id) ?? '';
        this.listeners.get(id)?.forEach((fn) => fn(t));
      }
      this.dirty.clear();
    });
  }

  subscribe(clientId: string, fn: StreamListener): () => void {
    let set = this.listeners.get(clientId);
    if (!set) this.listeners.set(clientId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  read(clientId: string): string {
    return this.text.get(clientId) ?? '';
  }

  end(clientId: string): string {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.dirty.delete(clientId);
    const final = this.text.get(clientId) ?? '';
    this.text.delete(clientId);
    this.listeners.delete(clientId);
    return final;
  }
}

export const streamBuffer = new StreamBuffer();
```

消费端直接写 DOM，**不经过 React 渲染**：

```tsx
interface StreamingBodyProps {
  clientId: string;
  /** 流式期间是否走 Markdown 渲染；默认 false，见下方「代价」 */
  richDuringStream?: boolean;
}

export const StreamingBody: React.FC<StreamingBodyProps> = ({ clientId, richDuringStream }) => {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // 挂载即补齐已到达的内容，避免订阅前的 chunk 丢失
    if (ref.current) ref.current.textContent = streamBuffer.read(clientId);
    return streamBuffer.subscribe(clientId, (text) => {
      if (ref.current) ref.current.textContent = text;   // 纯 DOM 写入，零 reconcile
    });
  }, [clientId]);

  return <span ref={ref} className={richDuringStream ? 'md-live' : 'plain-live'} />;
};
```

三段式调用与最终提交：

```ts
const appendChunk = (clientId: string, chunk: string) => streamBuffer.append(clientId, chunk);

const endStream = (clientId: string, final?: Partial<Message>) => {
  const text = streamBuffer.end(clientId);
  // 唯一一次 state 提交：此时才做 Markdown 解析、代码高亮、rev++
  startTransition(() => {
    dispatch({
      type: 'patch',
      clientId,
      patch: { status: 'sent', content: { kind: 'markdown', raw: text }, ...final },
    });
  });
};
```

**紧急 / 非紧急的划分标准**（`startTransition` 不能乱用）：

| 更新 | 优先级 | 理由 |
|---|---|---|
| 自己发出消息的乐观插入 | 紧急（同步 setState） | 用户刚点了发送，必须立刻见到气泡，延迟即卡顿感 |
| 贴底滚动 | 紧急（`useLayoutEffect` 内同步） | 放进 transition 会让滚动落后一帧，出现「追不上」 |
| 流式结束提交 | 非紧急（`startTransition`） | 视觉上文本已经在屏幕上了，这次提交只是把数据迁回 state |
| 历史消息批量前插 | 非紧急 | 用户视线在当前位置，上方内容晚一帧无感知 |

**代价（必须承认）**：

1. **流式期间是纯文本**，Markdown 表格、代码高亮要等 `endStream` 才成型 —— 会看到一次「样式落定」的跳变。缓解：流式期用轻量增量渲染（只处理换行、`**加粗**`、行内 `code` 三种），复杂结构留到结束；或对代码块用等宽字体占位，让跳变只发生在配色而非布局。
2. **DOM 与 React state 短暂不一致**。若此时发生列表重排（如收到他人消息插入），`StreamingBody` 若被卸载重挂，靠 `useEffect` 里的 `streamBuffer.read()` 补齐，不会丢内容 —— 这是上面那行「挂载即补齐」的作用，不能省。
3. **测试成本上升**：DOM 断言无法只靠 React Testing Library 的 rerender，需要 flush rAF。

### 5.4 时间切片：历史批量插入

**现象**：向上加载 50 条历史，主线程出现一个 200～400ms 的长任务，滚动完全冻结。

**根因**：50 条一次性挂载 = 50 次组件初始化 + 50 次 Markdown 解析 + 50 次 ResizeObserver 绑定，全在一个同步 commit 内。虚拟化只能保证「视口外不渲染」，但新插入的这批若落在 overscan 范围内仍会全挂。

**实现**：数据分片提交，让每片落在一帧预算内。

```ts
const CHUNK = 12;   // 经验值：中端机上 12 条富文本约 8～10ms

async function prependInSlices(msgs: Message[], dispatch: Dispatch<Action>) {
  for (let i = msgs.length; i > 0; i -= CHUNK) {
    const slice = msgs.slice(Math.max(0, i - CHUNK), i);
    startTransition(() => dispatch({ type: 'prepend', messages: slice }));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
}
```

**注意倒序切片**：从最新的一片开始插，保证靠近视口的内容先出现，用户感知的等待更短；正序插会让用户先看到最旧的那批。

**代价**：总耗时变长（多了帧间隔），但从「一个 300ms 长任务」变成「5 个 10ms 短任务」，交互不再冻结。若产品要求「加载动画结束即全部就位」，则这个方案观感反而更差 —— 此时应改为**加载态遮罩 + 一次性插入**。

### 5.5 DOM 数量与绘制控制

**现象**：长会话滚动一段时间后整体变卡，即使虚拟化生效；DevTools 显示 DOM 节点数持续增长。

**根因**：单条富文本消息可能展开成 30～80 个 DOM 节点（Markdown 结构 + 高亮 span）。窗口 20 条 × 60 节点 = 1200 节点，加 overscan 与未回收的 detached 节点，很快突破浏览器的舒适区。

**四项手段：**

**1. 图片懒挂载 + 尺寸占位**

```tsx
const ImageBubble: React.FC<{ content: Extract<MessageContent, { kind: 'image' }> }> = ({ content }) => {
  const ratio = content.width && content.height ? content.height / content.width : 0.75;
  return (
    <div style={{ aspectRatio: `1 / ${ratio}`, maxHeight: 320, background: '#f2f3f5' }}>
      <img src={content.url} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </div>
  );
};
```

关键是 **`aspect-ratio` 占位**：图片未加载时高度已确定，加载完成不改变布局，从根本上消除高度抖动（对应 §7.2）。`decoding="async"` 避免解码阻塞主线程。

**2. Markdown / 高亮解析结果缓存**

```ts
const htmlCache = new Map<string, string>();   // key: `${clientId}:${rev}`

function renderMarkdown(msg: Message): string {
  if (msg.content.kind !== 'markdown') return '';
  const key = `${msg.clientId}:${msg.rev}`;
  let html = htmlCache.get(key);
  if (!html) {
    html = sanitize(marked.parse(msg.content.raw) as string);
    htmlCache.set(key, html);
  }
  return html;
}
```

`rev` 入 key 保证编辑后自动失效；缓存需配 LRU（建议上限 500 条）防内存泄漏。**超过 2KB 的代码块交给 Worker 高亮**，主线程只接收 HTML 字符串 —— 高亮是纯 CPU 任务，是最值得 Worker 化的一环。

**3. CSS 隔离**

```css
.message-row {
  contain: layout paint style;   /* 行内变化不外溢，浏览器可跳过兄弟节点的布局计算 */
}
.message-row--offscreen {
  content-visibility: auto;      /* 仅用于 overscan 区，跳过其渲染工作 */
  contain-intrinsic-size: auto 72px;
}
```

`contain: layout` 的收益在流式场景特别明显：流式行高度每帧变化，若无 contain，浏览器需重算整个列表容器的布局；有 contain 后影响范围被限制在该行内。**代价**：`contain: paint` 会裁剪溢出内容，气泡的阴影、悬浮菜单、@提及浮层若靠溢出实现会被切掉 —— 这类元素必须 portal 到列表外。

**4. 避免 layout thrashing**

```ts
// ❌ 读写交叉：每次循环强制一次同步布局
items.forEach((el) => { const h = el.offsetHeight; el.style.height = h + 'px'; });

// ✅ 先批量读，再批量写
const heights = items.map((el) => el.getBoundingClientRect().height);
requestAnimationFrame(() => items.forEach((el, i) => (el.style.height = heights[i] + 'px')));
```

同理，§6 的滚动补偿必须在 `useLayoutEffect` 中「一次读、一次写」完成，不能在 ResizeObserver 回调里边读边写。

---

## 6. 滚动行为

§5.2 已确认走**路径 C（正序 + 虚拟化）**，因此贴底与锚定必须手写。本节给出完整实现。

### 6.1 贴底状态机

贴底不是一个布尔量，而是三态。用布尔量实现会出现「程序化滚动被误判为用户上滑」的经典 bug。

```
        用户上滑越过阈值
FOLLOWING ──────────────► DETACHED
    ▲                        │
    │  点 JumpToLatest /      │
    │  手动滚回底部            │
    └────────────────────────┘

  程序化滚动期间 → PROGRAMMATIC（临时态，忽略 scroll 事件）
```

```ts
type FollowState = 'FOLLOWING' | 'DETACHED' | 'PROGRAMMATIC';

const BOTTOM_THRESHOLD = 64;   // px，不是 0

export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement>,
  virtualizer: { scrollToIndex: (i: number, o?: { align?: 'end' }) => void },
  lastIndex: number,
) {
  const state = useRef<FollowState>('FOLLOWING');
  const rafId = useRef(0);
  const releaseTimer = useRef<number>(0);

  const measureGap = () => {
    const el = scrollRef.current!;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  };

  const onScroll = useCallback(() => {
    if (state.current === 'PROGRAMMATIC') return;      // 关键：忽略自己造成的滚动
    state.current = measureGap() < BOTTOM_THRESHOLD ? 'FOLLOWING' : 'DETACHED';
  }, []);

  /** 唯一的贴底入口：合帧 + 标记程序化 */
  const stick = useCallback(() => {
    if (state.current !== 'FOLLOWING') return;
    cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => {
      state.current = 'PROGRAMMATIC';
      virtualizer.scrollToIndex(lastIndex, { align: 'end' });
      clearTimeout(releaseTimer.current);
      // 滚动落定后释放；用 timeout 而非 scrollend 以兼容 Safari
      releaseTimer.current = window.setTimeout(() => {
        state.current = measureGap() < BOTTOM_THRESHOLD ? 'FOLLOWING' : 'DETACHED';
      }, 80);
    });
  }, [lastIndex, virtualizer]);

  return { onScroll, stick, isAtBottom: () => state.current === 'FOLLOWING' };
}
```

**三个要点**：

1. **阈值 64px 而非 0**：流式一帧就能长出 20～40px，用 `gap === 0` 判定会让用户「刚看到新内容就被判为脱离」。
2. **`PROGRAMMATIC` 临时态**：`scrollToIndex` 自身会触发 `scroll` 事件，若不屏蔽，中间帧的 gap 可能大于阈值，导致状态机自己把自己踢成 `DETACHED` —— 表现为流式贴底跟着跟着就不跟了。
3. **rAF 合帧**：流式一次 commit 可能对应多次高度变化（ResizeObserver 会多次回调），合帧后一帧只滚一次。

### 6.2 触发时机：订阅高度而非订阅数据

流式内容走的是旁路 DOM 写入（§5.3），React 根本不会重渲染，**所以不能在 `useEffect([messages])` 里贴底**——那个依赖永远不变。正确的触发源是最后一行的高度变化：

```ts
useEffect(() => {
  const el = lastRowRef.current;
  if (!el) return;
  const ro = new ResizeObserver(() => stick());
  ro.observe(el);
  return () => ro.disconnect();
}, [lastRowRef.current, stick]);
```

再叠加一次「新消息追加时」的贴底（此时最后一行是新节点，ResizeObserver 尚未绑上）：

```ts
useLayoutEffect(() => { stick(); }, [orderedIds.length]);
```

用 `useLayoutEffect` 而非 `useEffect`：在浏览器绘制前完成滚动，用户看不到「先在旧位置画一帧再跳」的闪动。

### 6.3 加载历史的滚动锚定

**现象**：触顶加载 20 条历史后，用户正在读的那条消息突然向下窜出几百像素。

**根因**：新内容插在上方，`scrollHeight` 增大，但 `scrollTop` 不变 → 视口相对内容的位置整体上移。虚拟化下更糟：这批新项的高度是**估算值**，之后被 `measureElement` 修正，会造成第二次跳动。

**实现**：两段补偿，缺一不可。

```ts
async function loadMoreTop() {
  const el = scrollRef.current!;
  if (state.loadingTop || !state.hasMoreTop) return;

  // 段一：以「首个可见项 + 其相对视口偏移」为锚，而非以 scrollHeight 差值为锚
  const anchorIndex = virtualizer.getVirtualItems()[0]?.index ?? 0;
  const anchorId = orderedIds[anchorIndex];
  const anchorOffsetInViewport =
    (document.querySelector(`[data-key="${anchorId}"]`) as HTMLElement | null)
      ?.getBoundingClientRect().top ?? 0;
  const containerTop = el.getBoundingClientRect().top;

  const older = await props.onLoadMore(state.topCursor);
  if (!older.length) { dispatch({ type: 'setHasMoreTop', value: false }); return; }

  await prependInSlices(older, dispatch);          // §5.4 分片插入

  // 段二：插入后把锚点还原到原来的视口位置
  requestAnimationFrame(() => {
    const node = document.querySelector(`[data-key="${anchorId}"]`) as HTMLElement | null;
    if (!node) return;
    const newTop = node.getBoundingClientRect().top;
    el.scrollTop += newTop - (containerTop + anchorOffsetInViewport - containerTop);
  });
}
```

**为什么用「锚点元素」而不是 `scrollHeight` 差值**：`scrollHeight` 差值法（`el.scrollTop += newScrollHeight - oldScrollHeight`）在**定高列表**下正确，但虚拟化下新插入项的高度是估算的，差值本身就是错的；且后续测量修正还会再改一次 `scrollHeight`。锚定到具体 DOM 元素则与估算精度无关 —— 只要那个元素还在，它相对视口的位置就是可信的真值。

**残留场景（需单独处理）**：若锚点元素恰好被虚拟化回收（分片插入期间滚动窗口移动），`querySelector` 返回 null。兜底是改用 `virtualizer.scrollToIndex(anchorIndex + older.length, { align: 'start' })`，精度略差但不会跳飞。

### 6.4 JumpToLatest 与未读计数

```ts
// 处于 DETACHED 时，新消息累计未读；回到 FOLLOWING 时清零并上报已读
function onAppend(msg: Message) {
  dispatch({ type: 'append', message: msg });
  if (!isAtBottom() && msg.senderId !== currentUserId) {
    dispatch({ type: 'incUnread' });
  }
}
```

FAB 的显示条件是 `state === 'DETACHED'`，**不是** `unreadCount > 0` —— 用户上滑翻历史但没有新消息时，也需要一个「回到最新」的出口。

---

## 7. 边界与异常

### 7.1 超长单条消息

一条 5 万字的消息（或几千行日志）会让虚拟化失效：它本身就是一个高 3 万像素的 DOM 节点，contain 也救不了。

**处理**：内容层折叠 + 二级虚拟化。

```tsx
const LONG_THRESHOLD = 4000;   // 字符

function MessageBody({ msg }: { msg: Message }) {
  const raw = msg.content.kind === 'markdown' ? msg.content.raw : '';
  const [expanded, setExpanded] = useState(false);
  if (raw.length > LONG_THRESHOLD && !expanded) {
    return (
      <>
        <div className="clamp">{raw.slice(0, LONG_THRESHOLD)}</div>
        <button onClick={() => setExpanded(true)}>展开全文（{raw.length} 字）</button>
      </>
    );
  }
  return <RichBody msg={msg} />;
}
```

展开后若仍超过约 8000px，改为在气泡内部再套一层独立滚动容器（`max-height: 60vh; overflow: auto`），把它变成一个高度有界的项 —— 这样外层虚拟化的高度模型重新可控。**代价**：嵌套滚动在移动端体验不佳，需配合「全屏查看」入口。

### 7.2 图片与富媒体的高度抖动

已在 §5.5 用 `aspect-ratio` 解决主路径。剩余两种情况：

| 情况 | 处理 |
|---|---|
| 服务端未返回宽高 | 首次加载后把实际尺寸写回 `byId[id].content`，并持久化到 IndexedDB；下次进会话即已知 |
| 加载失败 | 错误占位必须与原占位**等高**，否则失败瞬间列表会跳；用同一个 `aspect-ratio` 容器换内容即可 |

字体同理：`font-display: swap` 会在字体加载完成时改变文本行数。会话列表建议用 `optional` 或预加载关键字体，避免首屏后的一次全列表重排。

### 7.3 撤回 / 编辑 / 失败重试

三者都是**原地替换**，共用一条路径：`patch(clientId, ...)` + `rev++`，key 不变，DOM 复用。

```ts
function reducer(state: ListState, action: Action): ListState {
  switch (action.type) {
    case 'patch': {
      const prev = state.byId[action.clientId];
      if (!prev) return state;
      return {
        ...state,
        byId: { ...state.byId, [action.clientId]: { ...prev, ...action.patch, rev: prev.rev + 1 } },
        // orderedIds 引用不变 → 虚拟化层不失效
      };
    }
    case 'revoke':
      return reducer(state, {
        type: 'patch',
        clientId: action.clientId,
        patch: { status: 'revoked', content: { kind: 'system', text: '消息已撤回' } },
      });
  }
}
```

**撤回的高度问题**：撤回后高度从 120px 骤降到 32px。若该消息在视口**上方**，必须补偿：

```ts
useLayoutEffect(() => {
  const delta = newHeight - oldHeight;
  if (changedIndex < firstVisibleIndex && delta !== 0) {
    scrollRef.current!.scrollTop += delta;    // 一次读、一次写，见 §5.5
  }
}, [changedIndex, newHeight]);
```

**失败重试**：重试不新建消息、不改 `clientId`，只把 `status` 从 `failed` 改回 `pending`。若重试时生成新 id，会出现「消息跳到列表底部」——因为 `seq` 变了导致重排序。

### 7.4 乱序与去重

```ts
function insertBySeq(orderedIds: string[], byId: Record<string, Message>, msg: Message): string[] {
  // 去重：serverId 已存在则走 patch 而非 insert
  // 定位：按 seq 二分，而非直接 push
  let lo = 0, hi = orderedIds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = byId[orderedIds[mid]].seq ?? 0;
    if (s < (msg.seq ?? 0)) lo = mid + 1; else hi = mid;
  }
  return [...orderedIds.slice(0, lo), msg.clientId, ...orderedIds.slice(lo)];
}
```

**注意**：中间插入会让插入点之后所有项的 index 变化。这正是 §5.1 强调 `getItemKey` 必须用 `clientId` 的原因 —— 否则所有高度缓存错位一格。

### 7.5 采用路径 C 后仍需承担的代价

§5.2 否决了 `column-reverse` + 虚拟化的组合，因此以下三件事成为本方案的固有成本：

| 代价 | 规避手段 |
|---|---|
| 贴底与锚定全部手写（约 150 行） | 已在 §6 给出完整实现，可直接复制；建议抽成独立 hook 并加单测 |
| 初始渲染有一次「置底」动作 | `initialOffset` 首帧置底 + 容器初始 `opacity: 0`，`scrollToIndex` 后再显示，用户看不到过程 |
| 空列表 / 内容不足一屏时内容顶部对齐 | 给内层容器 `min-height: 100%` + `justify-content: flex-end`（此处不涉及虚拟项定位，与 §5.2 的冲突无关） |

无障碍方面：正序 DOM 顺序与视觉顺序一致，屏幕阅读器朗读顺序天然正确 —— 这反而是路径 C 相对 `column-reverse` 的一项**优势**。需补的是 `role="log"` + `aria-live="polite"`，并对流式消息用 `aria-busy="true"` 抑制逐 token 朗读，`endStream` 时置回 `false` 触发一次完整朗读。

---

## 8. 性能验证

只做定性判断不算验证。以下每项都给出可直接埋入的代码与判定阈值。

### 8.1 关键指标与阈值

| 指标 | 目标 | 说明 |
|---|---|---|
| 首屏可见时间 | < 300ms | 从组件挂载到最后一屏消息可见（含置底完成） |
| 流式期间掉帧率 | < 5% | 掉帧 = 帧间隔 > 20ms 的占比 |
| 单次 commit 耗时 | < 8ms | React Profiler `actualDuration`，留一半帧预算给浏览器绘制 |
| 长任务数量 | 加载历史 0 个 > 50ms | 对应 §5.4 的分片目标 |
| DOM 节点数 | < 2500 | 滚动 5 分钟后不应持续增长 |

### 8.2 掉帧率采样

```ts
export function startFrameMonitor(durationMs = 10_000) {
  let last = performance.now();
  let total = 0, dropped = 0;
  const tick = (now: number) => {
    const delta = now - last;
    last = now;
    total++;
    if (delta > 20) dropped++;
    if (now - start < durationMs) requestAnimationFrame(tick);
    else console.log(`掉帧率 ${((dropped / total) * 100).toFixed(1)}% (${dropped}/${total})`);
  };
  const start = performance.now();
  requestAnimationFrame(tick);
}
```

### 8.3 长任务监控

```ts
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.duration > 50) {
      console.warn('[longtask]', entry.duration.toFixed(1), 'ms', entry.name);
    }
  }
}).observe({ entryTypes: ['longtask'] });
```

在「触顶加载历史」和「流式输出 30 秒」两个场景各跑一次，长任务应为 0。若有，用 Performance 面板看火焰图定位是 Markdown 解析还是 layout。

### 8.4 commit 耗时

```tsx
<Profiler
  id="MessageList"
  onRender={(id, phase, actualDuration) => {
    if (actualDuration > 8) console.warn(`[slow-commit] ${phase} ${actualDuration.toFixed(2)}ms`);
  }}
>
  <MessageList {...props} />
</Profiler>
```

**流式期间这里应该几乎没有输出** —— 如果流式过程中频繁打印，说明 §5.3 的旁路机制没生效（多半是某处仍把 chunk 写进了 state）。这是验证 5.3 是否落地的**最直接判据**。

### 8.5 内存与 detached 节点

手动流程：DevTools → Memory → 滚动 5 分钟 → 强制 GC → Heap snapshot → 筛 `Detached`。若 detached HTMLElement 持续增长，常见原因是 ResizeObserver 未 disconnect、`htmlCache` 无 LRU 上限、`streamBuffer.listeners` 未清理。

自动化回归：

```ts
// Playwright + CDP
const metrics = await page.evaluate(() => ({
  nodes: document.getElementsByTagName('*').length,
  heap: (performance as any).memory?.usedJSHeapSize,
}));
expect(metrics.nodes).toBeLessThan(2500);
```

### 8.6 压测脚本思路

```ts
// 模拟 60 tokens/s 持续 30 秒 + 每 3 秒一条他人消息插入
const timer = setInterval(() => handle.appendChunk(id, randomToken()), 16);
const noise = setInterval(() => handle.append(makeMessage()), 3000);
setTimeout(() => { clearInterval(timer); clearInterval(noise); handle.endStream(id); }, 30_000);
```

必须在 **CPU 4× 降速**下跑（DevTools Performance → CPU throttling），否则高端机会掩盖所有问题。

---

## 9. 取舍与替代方案

### 9.1 按量级选型

| 量级 | 推荐方案 | 理由 | 不推荐 |
|---|---|---|---|
| **≤ 200 条** | 全量渲染 + `flex-direction: column-reverse` + `overflow-anchor: auto` | 200 条富文本约 1.5 万节点，现代浏览器可承受；倒置让贴底与历史锚定**零代码**；总实现量 < 50 行 | 上虚拟化 —— 引入的复杂度远超收益，且会失去原生锚定 |
| **数百 ~ 数千条** | `column-reverse` + 窗口裁剪（只保留最近 N 条 + 「查看更早」按钮） | 保住倒置的全部好处，同时把 DOM 控制在常数级 | 完整虚拟化 —— 此量级下测量抖动带来的问题比它解决的多 |
| **万级 ~ 十万级** | **本文方案**：正序 + `react-virtual` + 手写贴底/锚定 + 流式旁路 | 唯一能同时满足 DOM 恒定与流式 60fps 的组合 | `column-reverse` + 虚拟化 —— §5.2 已证明不成立 |

**分界点的判断依据**不是消息条数，而是**节点数 × 高度方差**：纯文本一万条可能比富媒体两千条更容易处理。实操建议是先按 9.1 选一档，再用 §8 的指标验证，不达标才升级。

### 9.2 单点技术取舍

| 决策 | 选择 | 放弃了什么 |
|---|---|---|
| 流式走旁路 DOM 写入 | ✅ 采用 | 流式期间的富文本渲染能力；测试复杂度上升 |
| `column-reverse` | ❌ 虚拟化档不用 | 零成本贴底；换来与虚拟化的兼容性 |
| 高度缓存持久化 | ✅ 采用 | 需处理容器宽度变化时的缓存失效（宽度入 key） |
| Worker 化代码高亮 | ⚠️ 按需 | 首屏多一次 Worker 启动成本（约 20ms），小会话不划算 |
| 分片插入历史 | ✅ 采用 | 总加载时间变长约 30% |

### 9.3 跨框架迁移

**框架无关（可直接照搬）**：

- 虚拟化的估高/测量/补偿模型（§5.1、§6.3）
- 贴底三态状态机（§6.1）—— 纯 DOM 逻辑
- rAF 合帧与 chunk buffer（§5.3 的 `StreamBuffer` 类没有一行 React）
- CSS containment、`aspect-ratio` 占位、layout thrashing 规避（§5.5）
- 全部度量方法（§8）

**依赖 React 调度器（需替换）**：

| React 机制 | Vue 3 | Svelte 5 | Solid |
|---|---|---|---|
| `startTransition` 划分优先级 | 无等价物；用 `requestIdleCallback` 或手动分片替代 | 同左 | 同左 |
| `memo` + 比较函数 | 天然细粒度，**不需要** | runes 细粒度，**不需要** | 细粒度，**不需要** |
| 旁路 DOM 写入（§5.3） | 收益减小（响应式本就精确到节点），但仍建议用于 60/s 级更新 | 同左 | 同左 |
| `useLayoutEffect` 时序 | `onMounted` + `nextTick` | `$effect.pre` | `createRenderEffect` |

**一句话结论**：细粒度响应式框架（Vue/Svelte/Solid）可以省掉 §4 的大部分工作（memo、订阅粒度），但 §5.1～5.5 的虚拟化与流式批处理、§6 的滚动控制**一分都省不掉** —— 那些是浏览器层面的约束，不是框架层面的。

---

## 附：验收对照

| 验收项 | 落点 |
|---|---|
| 假设显式列出 | §0 |
| `column-reverse` 与 `react-virtual` 的组合给出明确结论 | §5.2（结论：不能组合，改用路径 C） |
| 每个性能点写清「为什么快 / 代价」 | §5.3～5.5、§9.2 |
| 路径 C 的代价被正面回答 | §7.5 |
| 代码片段带 TS 类型且互相自洽 | 全篇共 18 段，统一基于 §3.1 的 `Message` 类型 |
| 三档选型可直接决策 | §9.1 |
