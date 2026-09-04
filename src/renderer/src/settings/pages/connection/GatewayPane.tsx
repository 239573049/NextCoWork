/**
 * 开放网关 —— 按参考图重排,但**状态那一块照实标注步骤 13 未监听**。
 *
 * ★ 这一页最容易犯的错是:把「端口 19836」印在界面上,让它看起来像是在监听。
 * 那三个开关今天全都只是在写库(`gateway.enabled` 全应用零消费者),HTTP 壳
 * 是步骤 13 —— 所以真实端口那一行是 `TodoRow`,而不是一个写死的数字。
 */
import type { ReactNode } from "react";
import { NumberInput } from "../../../components/ui/NumberInput";
import { Toggle } from "../../../components/ui/Toggle";
import { useI18n } from "../../../i18n";
import { LandsAt, SettingGroup, SettingRow, TodoRow } from "../../Row";
import type { SettingsPageProps } from "../../props";

export function GatewayPane({ settings, patch }: SettingsPageProps): ReactNode {
  const { t } = useI18n();
  const g = settings.gateway;
  return (
    <SettingGroup>
      <SettingRow
        title={t("connection.gateway.enable")}
        description={
          <>
            {t("connection.gateway.enableHint")}{" "}
            <LandsAt>{t("connection.gateway.step13")}</LandsAt>
          </>
        }
      >
        <Toggle
          label={t("connection.gateway.enable")}
          checked={g.enabled}
          onChange={(enabled) => patch({ gateway: { enabled } })}
        />
      </SettingRow>

      <SettingRow
        title={t("connection.gateway.port")}
        description={t("connection.gateway.portHint")}
      >
        <NumberInput
          value={g.preferredPort}
          min={1024}
          max={65535}
          ariaLabel={t("connection.gateway.port")}
          disabled={!g.enabled}
          onCommit={(preferredPort) => patch({ gateway: { preferredPort } })}
        />
      </SettingRow>

      <SettingRow
        title={t("connection.gateway.failover")}
        description={t("connection.gateway.failoverHint")}
      >
        <Toggle
          label={t("connection.gateway.failover")}
          checked={g.failover}
          disabled={!g.enabled}
          onChange={(failover) => patch({ gateway: { failover } })}
        />
      </SettingRow>

      <TodoRow
        title={t("connection.gateway.address")}
        description={t("connection.gateway.addressHint")}
        step="步骤 13:gateway:getStatus"
      />
      <TodoRow
        title={t("connection.gateway.interfaces")}
        description={t("connection.gateway.interfacesHint")}
        step="步骤 13"
      />
      <TodoRow
        title={t("connection.gateway.health")}
        description={t("connection.gateway.healthHint")}
        step="步骤 13:gateway:resetHealth"
        last
      />
    </SettingGroup>
  );
}
