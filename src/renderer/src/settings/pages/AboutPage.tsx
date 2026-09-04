import type { ReactNode } from 'react'
import type { Bootstrap } from '../../../../shared/domain/bootstrap'
import { SettingGroup, SettingRow } from '../Row'

/**
 * 版本号取自 `Bootstrap.versions`,不是 preload 的 `versions()` ——
 * 后者只有 electron/chrome/node,没有应用自己的版本号。
 */
export function AboutPage({ versions }: { versions: Bootstrap['versions'] }): ReactNode {
  const rows: ReadonlyArray<[string, string]> = [
    ['版本', versions.app],
    ['Electron', versions.electron],
    ['Chromium', versions.chrome],
    ['Node', versions.node]
  ]
  return (
    <SettingGroup>
      <SettingRow
        title="NextCoWork"
        description="本地优先的 AI 协作工作台。数据只存在这台电脑上。"
      />
      {rows.map(([k, v], i) => (
        <SettingRow key={k} title={k} last={i === rows.length - 1}>
          {/* 版本号是要被复制去贴到 issue 里的,全局 user-select:none 得在这里 opt-in */}
          <span className="selectable font-mono text-[12.5px] text-fg-muted">{v}</span>
        </SettingRow>
      ))}
    </SettingGroup>
  )
}
