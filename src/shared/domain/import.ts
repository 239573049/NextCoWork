/**
 * 从其他 AI 应用导入 —— 首版唯一来源是本机 Claude Code。
 *
 * ## 为什么这个类型文件先于一切存在
 *
 * 导入这件事横跨四层:只读的源适配器、SQLite 里的映射表、typed IPC、设置页。
 * 四层各自定义一套「类别」「结果码」的话,静默漂移的方式非常具体 ——
 * 适配器产出 `instruction`、界面按 `instructions` 筛、于是那一类永远显示 0 项,
 * 而没有任何一处会报错。**所以七类、结果码、诊断码在这里只写一遍。**
 *
 * ## 三条贯穿全文件的规矩
 *
 * 1. **诊断是码,不是句子。** 主进程不知道界面语言,把中文塞进诊断意味着
 *    英文界面上会冒出一句中文。`detail` 里放的是用户内容(路径、字段名),
 *    那部分本来就不该翻译。
 * 2. **源侧只读。** 这里没有任何「写回 Claude Code」的类型,是有意的边界 ——
 *    缺一个类型比缺一段注释更难被绕过。
 * 3. **密钥不进任何类型。** MCP 只搬键名,和 `domain/mcp.ts` 同一条规矩;
 *    预览项里因此只有 `secretNames`,没有值。
 */

// ═══════════════════════════════════════════════════════════════
// 一、来源与类别
// ═══════════════════════════════════════════════════════════════

/** 首版只有一个。留成联合是为了让 `switch` 在加第二个来源时报未覆盖。 */
export type ImportSourceKind = 'claude-code' | 'codex'

/**
 * 七类支持内容。
 *
 * ★ `project` 与 `chat` 是**两类**,不是一类:项目只建立/复用工作区与目录映射,
 * 聊天才是转录。合成一类的话,「只导配置不导聊天」这个组合就表达不出来,
 * 而它恰恰是最常见的一种(用户想换工具,但不想把几百条旧对话搬过来)。
 */
export type ImportCategory =
  | 'project'
  | 'chat'
  | 'skill'
  | 'mcp'
  | 'instructions'
  | 'agent'
  | 'command'
  | 'provider'
  | 'hook'

/**
 * 顺序即界面里的顺序。★ 这张表是「全选」的唯一依据 ——
 * 升级后新增的类别**不会**因为用户当初点过全选就自动获得授权
 * (`ImportSyncState.categories` 存的是具体类别名,不是一个 all 标志)。
 */
export const IMPORT_CATEGORIES: readonly ImportCategory[] = [
  'project',
  'chat',
  'skill',
  'mcp',
  'instructions',
  'agent',
  'command',
  'provider',
  'hook'
]

export function isImportCategory(value: unknown): value is ImportCategory {
  return typeof value === 'string' && (IMPORT_CATEGORIES as readonly string[]).includes(value)
}

/** 来源探测的结果。★ 「没找到」和「没权限」必须分得开,两者的下一步操作不同。 */
export type ImportSourceAvailability = 'detected' | 'not-found' | 'denied' | 'unreadable'

export interface ImportSourceDetection {
  /** 本机来源身份。同一台机器重复扫描复用它,映射表按它分区。 */
  sourceId: string
  kind: ImportSourceKind
  availability: ImportSourceAvailability
  /** 已授权的配置目录绝对路径。未检测到时是空串。 */
  configDir: string
  /** 探测方式 —— 界面要照实说「自动找到的」还是「你自己选的」。 */
  origin: 'auto' | 'env' | 'user-picked'
  projectCount: number
  sessionCount: number
  lastScanAt?: number
  /** availability 非 detected 时的原因码。 */
  diagnostics: ImportDiagnostic[]
}

// ═══════════════════════════════════════════════════════════════
// 二、诊断
// ═══════════════════════════════════════════════════════════════

/**
 * ★ 每一条都对应一个**用户看得懂的后果**,不是内部错误分类。
 *
 * 判据很直接:如果一条诊断翻成人话之后是「内部解析失败」,它就不该单独存在 ——
 * 那种东西应该并进 `source.unreadable`,而不是让界面上出现一个用户无法处理的状态。
 */
export type ImportDiagnosticCode =
  // ── 来源侧 ──
  | 'source.not-found'
  | 'source.denied'
  | 'source.unreadable'
  | 'source.changed-during-scan'
  | 'source.missing' // 曾经导入过,现在源侧没了
  // ── 转录 ──
  | 'transcript.unparsable'
  | 'transcript.branch-unresolvable'
  | 'transcript.truncated-tail'
  | 'transcript.oversize'
  | 'transcript.empty'
  | 'tool.unencodable' // 工具记录降级成普通历史正文
  | 'attachment.missing'
  | 'attachment.external-url' // 临时 URL,不联网下载
  // ── 项目 ──
  | 'project.needs-workspace' // 源目录不存在,必须先选本地目标
  | 'project.path-unresolvable'
  // ── 资产 ──
  | 'skill.unsupported-constraint' // disable-model-invocation 等本地未实现的约束
  | 'skill.package-too-large'
  | 'agent.unknown-tools'
  | 'agent.model-unresolved'
  | 'agent.unsupported-permission'
  | 'command.dynamic-shell' // `!`(…) 之类的动态插值
  | 'instructions.unsupported-directive' // @ 导入 / 路径限定 rules
  // ── MCP ──
  | 'mcp.unsupported-transport'
  | 'mcp.missing-type'
  | 'mcp.needs-secrets'
  | 'mcp.possible-inline-credential'
  | 'mcp.command-changed' // 执行入口变了,必须重新确认
  // ── Codex provider / model ──
  | 'provider.needs-credentials'
  | 'provider.needs-manual-setup'
  | 'provider.unsupported-options'
  | 'provider.auth-command-skipped'
  | 'provider.project-scope-ignored'
  | 'model.metadata-incomplete'
  | 'model-provider-unresolved'
  // ── Codex hooks ──
  | 'hook.unsupported-event'
  | 'hook.unsupported-handler'
  | 'hook.matcher-needs-review'
  | 'hook.async-semantics-changed'
  | 'hook.protocol-needs-review'
  | 'hook.plugin-skipped'
  | 'hook.trust-state-skipped'
  // ── Codex skills / transcript ──
  | 'skill.disabled-in-source'
  | 'skill.compatibility-path'
  | 'transcript.schema-unknown'
  | 'transcript.developer-content-skipped'
  | 'transcript.tool-pair-incomplete'
  // ── 目标侧 ──
  | 'target.name-conflict'
  | 'target.locally-modified'
  | 'target.detached' // 用户续聊/编辑过,已永久脱离同步
  | 'target.deleted' // 本地删过,tombstone 抑制复活

export interface ImportDiagnostic {
  code: ImportDiagnosticCode
  /**
   * 用户内容(路径、字段名、工具名)。★ **不翻译**,也不放句子 ——
   * 句子由渲染层按 code 组装。
   */
  detail?: string
}

// ═══════════════════════════════════════════════════════════════
// 三、预览
// ═══════════════════════════════════════════════════════════════

/**
 * 单项在预览里的处置。
 *
 * ★ 没有 `overwrite`。「已有同名配置默认跳过,显式另存新名可保留两份」是
 * 已确认的决策 —— 类型里根本不提供覆盖这个取值,是为了让「将来某个人顺手加个
 * 默认覆盖」变成一次需要改类型的显式动作。
 */
export type ImportItemStatus =
  | 'new'
  | 'update'
  | 'exists'
  | 'conflict'
  | 'incompatible'
  | 'needs-target'

export interface ImportPreviewItem {
  /**
   * 稳定项键。★ 同一份源内容重复扫描必须得到同一个 id ——
   * 它就是 `import_mappings.source_item_id`,「导入两次仍一份」全靠它。
   */
  id: string
  category: ImportCategory
  /** 展示名(会话标题 / 技能名 / 服务器名)。用户内容,不翻译。 */
  title: string
  /** 源路径或来源描述。界面要照实显示,用户据此认出这是哪一份。 */
  sourcePath: string
  status: ImportItemStatus
  /** 归属项目的稳定键。全局作用域的项没有它。 */
  projectKey?: string
  /** 目标工作区。★ 聊天与项目级配置**必须**有,否则 status 是 needs-target。 */
  targetWorkspaceId?: string
  /** 作用域:项目级配置只在对应工作区生效,全局级对所有工作区生效。 */
  scope: 'global' | 'project'
  /** 会话消息数 / 技能文件数之类。界面显示用,不参与判定。 */
  count?: number
  bytes?: number
  /** 源侧时间,给「最近的排前面」用。 */
  sourceUpdatedAt?: number
  /** Safe metadata for provider/hook rows; secrets and command output are excluded. */
  provider?: { protocol: string; baseUrl: string; profile: string; model?: string; envKey?: string }
  hook?: { event: string; matcher?: string; command?: string; timeoutMs?: number }
  diagnostics: ImportDiagnostic[]
  /** 默认勾选。incompatible 与 exists 默认不勾。 */
  defaultSelected: boolean
}

/** 项目候选 —— 「选择导入」弹窗里「项目」那一组的行。 */
export interface ImportProjectCandidate {
  /** 稳定键。由**可信解析后的 cwd** 归一化而来,不是从连字符编码目录反推的。 */
  key: string
  /** 源项目的真实根路径。解析不出时是空串,此时必须让用户选目标。 */
  sourcePath: string
  /** 源路径在本机是否真的存在且可读。 */
  accessible: boolean
  /** 已匹配到的本地工作区(按规范化路径复用,不按显示名)。 */
  targetWorkspaceId?: string
  targetWorkspaceName?: string
  sessionCount: number
  lastActivityAt?: number
  diagnostics: ImportDiagnostic[]
}

export interface ImportPreviewCounts {
  /** 按类别的项数。缺席 = 该类别这次没有任何项。 */
  byCategory: Partial<Record<ImportCategory, number>>
  byStatus: Partial<Record<ImportItemStatus, number>>
  total: number
}

/**
 * 预览句柄。★ **正文不在这里。**
 *
 * 主进程握着一份不可变的规范化快照,这里只回 id + 计数 + 项目候选;
 * 具体条目按页走 `imports:previewItems` 取。100 个会话 × 100 条消息
 * 整包过一次结构化克隆,就是设置页打开时肉眼可见的一卡。
 */
export interface ImportPreview {
  previewId: string
  sourceId: string
  createdAt: number
  /** 绝对时间戳。过期后提交被拒,必须重新扫描 —— 源可能已经变了。 */
  expiresAt: number
  counts: ImportPreviewCounts
  projects: ImportProjectCandidate[]
  /** 扫描期间发现的、不属于任何单项的问题(整个来源级别的)。 */
  diagnostics: ImportDiagnostic[]
}

export interface ImportPreviewPage {
  items: ImportPreviewItem[]
  /** 该筛选条件下的总数,用来画分页。 */
  total: number
  offset: number
}

/** 预览分页查询。category 省略 = 全部类别。 */
export interface ImportPreviewQuery {
  previewId: string
  category?: ImportCategory
  /** 会话搜索 / 项目过滤。对 title 与 sourcePath 做包含匹配。 */
  q?: string
  projectKey?: string
  offset: number
  limit: number
}

// ═══════════════════════════════════════════════════════════════
// 四、提交与作业
// ═══════════════════════════════════════════════════════════════

/**
 * 提交请求。★ 只接受**快照内**的项 id。
 *
 * 不接受路径、不接受内容 —— 渲染层递一条任意路径进来就能让导入器去读它,
 * 那等于给了渲染层一个任意文件读取入口(方案 §9 反对的正是这个)。
 */
export interface ImportApplyRequest {
  previewId: string
  /** 用户勾选的项。空数组非法(提交按钮应当已经置灰)。 */
  itemIds: string[]
  /** 项目 key → 目标工作区 id。聊天要落地必须先有这一条。 */
  workspaceTargets: Array<{ projectKey: string; workspaceId: string }>
  /** 防双击重入。同一个 requestId 重复提交返回同一个 job。 */
  requestId: string
}

export type ImportJobPhase =
  | 'scanning'
  | 'ready'
  | 'importing'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled'
  /** 上次进程没跑完就退出了。★ 不伪报完成 —— 按已提交映射安全重扫。 */
  | 'interrupted'

export interface ImportCounts {
  imported: number
  updated: number
  skipped: number
  conflict: number
  failed: number
  incompatible: number
}

export const EMPTY_IMPORT_COUNTS: ImportCounts = {
  imported: 0,
  updated: 0,
  skipped: 0,
  conflict: 0,
  failed: 0,
  incompatible: 0
}

/**
 * 正在跑的那个作业。渲染层只消费,不持有 ——
 * 「导入过程中可关闭设置页,任务继续」就是这句话的直接后果。
 */
export interface ImportJobStatus {
  jobId: string
  sourceId: string
  trigger: 'manual' | 'auto'
  phase: ImportJobPhase
  /** 已处理 / 总数。scanning 阶段 total 可能是 0(还没数完)。 */
  done: number
  total: number
  /** 当前项的展示名,给进度条下面那行小字。用户内容。 */
  currentTitle?: string
  counts: ImportCounts
  startedAt: number
  endedAt?: number
  /** 终态失败时的原因码。 */
  diagnostics: ImportDiagnostic[]
}

// ═══════════════════════════════════════════════════════════════
// 五、历史
// ═══════════════════════════════════════════════════════════════

export type ImportResultCode =
  | 'imported'
  | 'updated'
  | 'skipped'
  | 'conflict'
  | 'failed'
  | 'cancelled'
  | 'incompatible'

/** 明细行指向的本地实体。界面据此决定「打开聊天」还是「去连接设置」。 */
export type ImportTargetKind =
  | 'session'
  | 'workspace'
  | 'skill'
  | 'agent'
  | 'command'
  | 'instructions'
  | 'mcp'
  | 'provider'
  | 'alias'
  | 'hook'

export interface ImportBatchSummary {
  id: string
  sourceId: string
  sourceKind: ImportSourceKind
  trigger: 'manual' | 'auto'
  startedAt: number
  endedAt?: number
  phase: ImportJobPhase
  counts: ImportCounts
}

export interface ImportBatchItem {
  batchId: string
  category: ImportCategory
  /** 用户内容。 */
  title: string
  sourcePath: string
  result: ImportResultCode
  targetKind?: ImportTargetKind
  targetId?: string
  targetWorkspaceId?: string
  /** 目标已被删除 —— 界面显示成不可打开,不复活数据。 */
  targetMissing?: boolean
  diagnostics: ImportDiagnostic[]
}

export interface ImportHistoryPage {
  batches: ImportBatchSummary[]
  total: number
  offset: number
}

export interface ImportBatchItemsPage {
  items: ImportBatchItem[]
  total: number
  offset: number
}

// ═══════════════════════════════════════════════════════════════
// 六、自动同步
// ═══════════════════════════════════════════════════════════════

export type ImportSyncStatus = 'off' | 'idle' | 'running' | 'paused' | 'error'

export interface ImportSyncState {
  enabled: boolean
  status: ImportSyncStatus
  /** 已授权的类别。★ 存具体名字,不存 all —— 见 IMPORT_CATEGORIES 的注释。 */
  categories: ImportCategory[]
  /** 已授权自动同步的项目 key。新项目只提醒,不自动扩大授权。 */
  projectKeys: string[]
  /** 上次**检查**时间。无变化的检查只更新它,不制造空批次。 */
  lastCheckAt?: number
  /** 上次真的写入了东西的时间。 */
  lastSyncAt?: number
  /** paused / error 时的原因码。 */
  diagnostics: ImportDiagnostic[]
}

export interface ImportSyncPatch {
  enabled?: boolean
  categories?: ImportCategory[]
  projectKeys?: string[]
}

/** 导入页一次性要的全部状态。一条 IPC 取回,省掉三次往返各自到达造成的半旧界面。 */
export interface ImportSourceState {
  detection: ImportSourceDetection
  sync: ImportSyncState
  /** 正在跑的作业。没有就是 null。 */
  job: ImportJobStatus | null
}

/** 冲突处置。★ 没有「用源覆盖本地」——那正是本功能承诺不做的事。 */
export interface ImportConflictResolution {
  sourceId: string
  itemId: string
  /** keep-local = 保留本地并解除该项同步;save-as = 另存一份新名。 */
  action: 'keep-local' | 'save-as'
  /** save-as 时的新名字。 */
  name?: string
}

// ═══════════════════════════════════════════════════════════════
// 七、限额 —— 集中定义,不散落
// ═══════════════════════════════════════════════════════════════

/**
 * ★ 超限的项**报告出来**,不截断后冒充完整导入。
 *
 * 资产包沿用 `kernel/skill/install.ts` 已验证的那套上限(50MiB / 1000 项 / 深度 12),
 * 不在这里复制数值 —— 复制出来的第二份迟早和第一份对不上,而对不上的表现是
 * 「预览说能装,装的时候失败」。
 */
export const IMPORT_LIMITS = {
  /** 单个 JSONL 转录文件。超过的会话标记 transcript.oversize,不解析。 */
  transcriptFileMaxBytes: 128 * 1024 * 1024,
  /** 单行。一行 8MiB 已经是一次巨型工具输出,再大就不是对话了。 */
  transcriptLineMaxBytes: 8 * 1024 * 1024,
  /** 一次扫描最多认多少个会话,防止一个异常目录把主进程拖住。 */
  maxSessionsPerScan: 2000,
  /** 单会话最多多少条消息。 */
  maxMessagesPerSession: 20000,
  /** 预览快照存活时间。过期必须重新扫描 —— 源可能已经变了。 */
  previewTtlMs: 5 * 60 * 1000,
  /** 历史与预览的分页大小。 */
  pageSize: 50,
  /** 自动同步扫描间隔。应用运行期间,不是常驻 daemon。 */
  syncIntervalMs: 30 * 1000
} as const

/** 本地 MCP id 的字符与长度限制,与 `MCP_SERVER_ID_RE` 对齐。 */
export const IMPORT_MCP_ID_MAX = 32
