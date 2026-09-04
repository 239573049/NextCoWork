/**
 * 开放网关 —— 按参考图重排,但**状态那一块照实标注步骤 13 未监听**。
 *
 * ★ 这一页最容易犯的错是:把「端口 19836」印在界面上,让它看起来像是在监听。
 * 那三个开关今天全都只是在写库(`gateway.enabled` 全应用零消费者),HTTP 壳
 * 是步骤 13 —— 所以真实端口那一行是 `TodoRow`,而不是一个写死的数字。
 */
import type { ReactNode } from 'react'
import { NumberInput } from '../../../components/ui/NumberInput'
import { Toggle } from '../../../components/ui/Toggle'
import { LandsAt, SettingGroup, SettingRow, TodoRow } from '../../Row'
import type { SettingsPageProps } from '../../props'

export function GatewayPane({ settings, patch }: SettingsPageProps): ReactNode {
  const g = settings.gateway
  return (
    <SettingGroup>
      <SettingRow
        title="启用本地网关"
        description={
          <>
            把已配置的模型以 OpenAI / Anthropic 兼容协议暴露在本机,给别的工具用。
            ★ 只绑 127.0.0.1,不对局域网开放。默认关闭(方案 §5.4)。{' '}
            <LandsAt>步骤 13 起真正监听</LandsAt>
          </>
        }
      >
        <Toggle
          label="启用本地网关"
          checked={g.enabled}
          onChange={(enabled) => patch({ gateway: { enabled } })}
        />
      </SettingRow>

      <SettingRow
        title="期望端口"
        description="被占用时会自动另选一个,所以这里存的是「期望」值,不是实际监听的端口。"
      >
        <NumberInput
          value={g.preferredPort}
          min={1024}
          max={65535}
          ariaLabel="期望端口"
          disabled={!g.enabled}
          onCommit={(preferredPort) => patch({ gateway: { preferredPort } })}
        />
      </SettingRow>

      <SettingRow
        title="故障切换"
        description="上游报错时自动换到下一个提供同一别名的供应商,按供应商优先级顺序(方案 §5.2)。"
      >
        <Toggle
          label="故障切换"
          checked={g.failover}
          disabled={!g.enabled}
          onChange={(failover) => patch({ gateway: { failover } })}
        />
      </SettingRow>

      <TodoRow
        title="网关地址与密钥"
        description="监听到的实际端口、访问密钥、以及复制成 base_url 的按钮。"
        step="步骤 13:gateway:getStatus"
      />
      <TodoRow
        title="可用接口"
        description="/v1/messages 与 /v1/chat/completions 两套协议的互转。"
        step="步骤 13"
      />
      <TodoRow
        title="上游健康度"
        description="每个供应商的连续失败次数与熔断状态,可手动重置。"
        step="步骤 13:gateway:resetHealth"
        last
      />
    </SettingGroup>
  )
}
