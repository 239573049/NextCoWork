import { useRef, useState, type ReactNode } from 'react'
import { NumberInput } from '../../components/ui/NumberInput'
import { TextInput } from '../../components/ui/TextInput'
import { Toggle } from '../../components/ui/Toggle'
import { SettingField, SettingGroup, SettingRow, TodoRow } from '../Row'
import type { SettingsPageProps } from '../props'
import { normalizeProxyUrl } from '../validate'

export function ConnectionPage({ settings, sub, patch }: SettingsPageProps): ReactNode {
  if (sub === 'proxy') {
    return (
      <SettingGroup>
        <SettingRow
          title="启用代理"
          description="对 AI 模型请求生效 —— 注入到 KernelHost.fetch。落点:步骤 4 接上供应商之后。"
        >
          <Toggle
            label="启用代理"
            checked={settings.proxy.enabled}
            onChange={(enabled) => patch({ proxy: { enabled } })}
          />
        </SettingRow>
        <SettingField
          title="代理地址"
          description="不写协议时按 http:// 处理,所以直接填 127.0.0.1:7890 就行。支持 http / https / socks5 / socks4。"
          last
        >
          <ProxyUrlInput
            value={settings.proxy.url}
            disabled={!settings.proxy.enabled}
            onCommit={(url) => patch({ proxy: { url } })}
          />
        </SettingField>
      </SettingGroup>
    )
  }

  return (
    <SettingGroup>
      <SettingRow
        title="启用本地网关"
        description="把本机的模型接口以 OpenAI 兼容协议暴露出去。★ 默认关闭(方案 §5.4)。"
      >
        <Toggle
          label="启用本地网关"
          checked={settings.gateway.enabled}
          onChange={(enabled) => patch({ gateway: { enabled } })}
        />
      </SettingRow>
      <SettingRow
        title="期望端口"
        description="被占用时会另选一个,所以这里存的是**期望**值而不是实际监听的端口。"
      >
        <NumberInput
          value={settings.gateway.preferredPort}
          min={1024}
          max={65535}
          ariaLabel="期望端口"
          disabled={!settings.gateway.enabled}
          onCommit={(preferredPort) => patch({ gateway: { preferredPort } })}
        />
      </SettingRow>
      <SettingRow
        title="故障切换"
        description="上游报错时自动换到下一个提供同一别名的供应商(方案 §5.2)。"
      >
        <Toggle
          label="故障切换"
          checked={settings.gateway.failover}
          disabled={!settings.gateway.enabled}
          onChange={(failover) => patch({ gateway: { failover } })}
        />
      </SettingRow>
      <TodoRow
        title="网关状态"
        description="实际监听端口、健康度、重置健康计数。"
        step="步骤 13:gateway:getStatus"
        last
      />
    </SettingGroup>
  )
}

/**
 * 草稿态输入框 —— 受控绑到 prop 上的话,每敲一个字符就是一次 IPC 往返加一次
 * 广播回灌,光标会跳;而且打字途中一定会经过 `http:/` 这种非法中间态。
 *
 * 回灌用**渲染期比对**(同 `Composer.tsx` 里那个 `seenWorkspace` 的写法),
 * 不用 `useEffect([value])` —— 后者正是那份注释点名的 bug。
 * 有焦点时不回灌,所以别的窗口在你打字期间改了同一个字段也不会把你的字冲掉;
 * 你失焦提交时最后写,你赢。桌面端这就是对的。
 */
function ProxyUrlInput({
  value,
  disabled,
  onCommit
}: {
  value: string
  disabled: boolean
  onCommit: (v: string) => void
}): ReactNode {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  const focused = useRef(false)

  if (value !== seen && !focused.current) {
    setSeen(value)
    setDraft(value)
  }

  const normalized = normalizeProxyUrl(draft)

  return (
    <div onFocusCapture={() => (focused.current = true)}>
      <TextInput
        value={draft}
        onChange={setDraft}
        onCommit={() => {
          focused.current = false
          if (normalized === null) {
            setDraft(value) // 不合法就还原 —— 存一个存不进去的地址比空着更糟
            return
          }
          setDraft(normalized)
          if (normalized !== value) onCommit(normalized)
        }}
        onRevert={() => {
          focused.current = false
          setDraft(value)
        }}
        invalid={normalized === null}
        disabled={disabled}
        ariaLabel="代理地址"
        inputMode="url"
        placeholder="127.0.0.1:7890"
      />
    </div>
  )
}
