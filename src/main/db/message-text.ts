/**
 * 一份消息的**可搜索正文** —— FTS 虚表的 `content` 列就是它。
 *
 * ## 为什么单独一个模块
 *
 * 两个写入路径必须算出**逐字相同**的字符串:
 * - `db/repo.ts` 的 `upsertFts`(每条消息正常落盘时);
 * - `db/legacy-merge.ts` 的补索引(旧库行级合并把行整条搬进来时)。
 *
 * 各写一份的话,同一段对话在两条路径上命中的词不一样,而**没有任何测试会红**
 * —— 表现是「旧库迁进来的会话搜得到一部分、搜不到另一部分」这种只在特定机器
 * 上复现的怪事。放进仓库根下这个**叶子模块**(不 import 任何仓库内模块),
 * 是为了让 `legacy-merge` 能拿走它而不引入「合并 → repo → 数据库句柄」那条依赖:
 * 合并跑在 `openDatabase()` **之前**,那时候主连接还不存在。
 *
 * 容错是刻意的:整条不是数组就当空,单个坏块(循环引用、getter 抛错)只丢它
 * 自己。迁移路径上一条畸形行都不该让整次启动失败,而搜索少一个词远好过卡住。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ContentPart } from '../../shared/agent/message'

export function searchableMessageText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  const chunks: string[] = []
  for (const part of parts as readonly ContentPart[]) {
    if (part === null || typeof part !== 'object') continue
    try {
      switch (part.type) {
        case 'text':
        case 'thinking':
          if (typeof part.text === 'string') chunks.push(part.text)
          break
        case 'tool_call':
          if (typeof part.name === 'string') chunks.push(part.name)
          if (part.input !== undefined) chunks.push(JSON.stringify(part.input) ?? '')
          break
        case 'tool_result': {
          const output = (part as { output?: unknown }).output
          const content = typeof output === 'object' && output !== null
            ? (output as { content?: unknown }).content
            : undefined
          if (typeof content === 'string') chunks.push(content)
          break
        }
        case 'subagent':
          if (typeof part.summary === 'string') chunks.push(part.summary)
          break
        case 'error': {
          const error = (part as { error?: unknown }).error
          const message = typeof error === 'object' && error !== null
            ? (error as { message?: unknown }).message
            : undefined
          if (typeof message === 'string') chunks.push(message)
          break
        }
        default:
          break
      }
    } catch {
      // 单个坏块只丢它自己,不丢整条消息。
    }
  }
  return chunks.filter(Boolean).join('\n')
}

/** 接受调用方的真实连接，启动迁移不得触发应用的内存库兜底。调用方负责事务。 */
function indexMessageRows(database: DatabaseSync, sessionId?: string): number {
  const rows = database.prepare(
    `SELECT m.id, m.session_id, m.parts, s.title FROM messages m JOIN sessions s ON s.id = m.session_id
     ${sessionId === undefined ? '' : 'WHERE m.session_id = ?'} ORDER BY m.id`
  ).iterate(...(sessionId === undefined ? [] : [sessionId]))
  const insert = database.prepare('INSERT INTO messages_fts (message_id, session_id, title, content) VALUES (?, ?, ?, ?)')
  let count = 0
  for (const row of rows) {
    let parts: unknown = []
    try { parts = JSON.parse(String(row['parts'])) } catch { /* 损坏正文只索引标题 */ }
    insert.run(String(row['id']), String(row['session_id']), String(row['title'] ?? ''), searchableMessageText(parts))
    count++
  }
  return count
}

export function backfillSessionFts(database: DatabaseSync, sessionId: string): number {
  if (sessionId === '') return 0
  database.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(sessionId)
  return indexMessageRows(database, sessionId)
}

/** 一次性修复历史漏索引，同时清掉已删除消息的幽灵结果。 */
export function rebuildMessageFts(database: DatabaseSync): number {
  database.exec('DELETE FROM messages_fts')
  return indexMessageRows(database)
}
