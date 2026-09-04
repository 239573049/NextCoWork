import { useEffect, useState, type ReactNode } from 'react'
import type { StorageStats } from '../../../../shared/domain/settings'
import { Button } from '../../components/ui/Button'
import { tryInvoke } from '../../services/ipc'
import { formatBytes, formatCount } from '../format'
import { SettingGroup, SettingRow, TodoRow } from '../Row'

/**
 * 结构照参考图做出来,数字取不到 —— `storage:getStats` 是步骤 6。
 *
 * ★ 用 `tryInvoke` 不用 `invoke`:未实现的频道会抛 `NotImplementedError`,
 * `invoke` 会把它变成 `AgentErrorException` 抛出来,`void getStats()` 没接住
 * 就是 dev 下一条 unhandled rejection。`services/ipc.ts` 那句「失败也是正常结果
 * 的场景用 tryInvoke」说的就是这里。
 */
export function DataPage(): ReactNode {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let alive = true
    void tryInvoke('storage:getStats', undefined).then((r) => {
      if (!alive) return
      if (r.ok) setStats(r.data)
      else setUnavailable(true)
    })
    return () => {
      alive = false
    }
  }, [])

  if (unavailable) {
    return (
      <SettingGroup title="存储">
        <TodoRow title="数据库大小" step="步骤 6:storage:getStats" />
        <TodoRow title="对话数量" step="步骤 6:storage:getStats" />
        <TodoRow title="消息数量" step="步骤 6:storage:getStats" />
        <TodoRow
          title="优化存储"
          description="对 SQLite 做一次 VACUUM,回收 WAL 占用的空间。"
          step="步骤 6:storage:vacuum"
          last
        />
      </SettingGroup>
    )
  }

  return (
    <SettingGroup title="存储">
      <SettingRow title="数据库大小">
        <span className="selectable text-[13px] text-fg">{formatBytes(stats?.dbBytes)}</span>
      </SettingRow>
      <SettingRow title="对话数量">
        <span className="selectable text-[13px] text-fg">
          {formatCount(stats?.conversationCount)}
        </span>
      </SettingRow>
      <SettingRow title="消息数量">
        <span className="selectable text-[13px] text-fg">{formatCount(stats?.messageCount)}</span>
      </SettingRow>
      <SettingRow
        title="优化存储"
        description={`对 SQLite 做一次 VACUUM,回收 WAL 占用的空间(当前 ${formatBytes(stats?.walBytes)})。`}
        last
      >
        {/* vacuum 回的是**整理之后**的 StorageStats,直接拿来刷新这一页 */}
        <Button
          onClick={() => {
            void tryInvoke('storage:vacuum', undefined).then((r) => {
              if (r.ok) setStats(r.data)
            })
          }}
        >
          优化存储
        </Button>
      </SettingRow>
    </SettingGroup>
  )
}
