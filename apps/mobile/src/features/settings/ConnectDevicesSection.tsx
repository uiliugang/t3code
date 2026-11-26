import { AuthAccessReadScope, AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { authEnvironment } from "../../state/auth";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeConnectDevice } from "../connection/connectDeviceApproval";
import { SettingsSection } from "./components/SettingsSection";

export function ConnectDevicesSection({
  environmentId,
  requireApproval,
}: {
  readonly environmentId: EnvironmentId;
  readonly requireApproval: boolean;
}) {
  const t = useUiTranslation();
  const prepared = usePreparedConnection(environmentId);
  const read = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const write = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const encrypted = prepared._tag === "Some" && prepared.value.transport === "noise";
  const access = useEnvironmentQuery(
    read && encrypted ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const revoke = useAtomCommand(authEnvironment.revokeConnectDevice, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const devices = access.data?.type === "snapshot" && access.data.payload.connectDevices;
  if (!devices || devices.length === 0 || !read || !encrypted) return null;
  return (
    <SettingsSection title={t("T3 Connect devices")}>
      {devices.map((device) => {
        // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- Approved device records carry display metadata in this field.
        const metadata = device.client;
        const label = metadata ? describeConnectDevice(metadata, t) : t("Unknown device");
        const target = device.proofKeyThumbprint;
        return (
          <ListActionRow
            key={target}
            label={label}
            description={device.verificationCode}
            {...(write ? { detail: t("Revoke") } : {})}
            disabled={!write || pending !== null}
            loading={pending === target}
            onPress={() =>
              Dialog.confirm({
                title: t("Revoke {device}?", { device: `${label} · ${device.verificationCode}` }),
                message: requireApproval
                  ? t("The device has to be approved here before it can connect again.")
                  : t(
                      "Approval for new devices is off, so a revoked device signed in to your T3 Connect account can connect again on its own.",
                    ),
                confirmText: t("Revoke"),
                destructive: true,
                onConfirm: async () => {
                  setPending(target);
                  const result = await revoke({
                    environmentId,
                    input: { proofKeyThumbprint: target },
                  });
                  setPending(null);
                  if (result._tag === "Failure")
                    Dialog.alert(
                      t("Could not confirm device revocation"),
                      formatEnvironmentQueryError(result.cause),
                    );
                },
              })
            }
          />
        );
      })}
    </SettingsSection>
  );
}
