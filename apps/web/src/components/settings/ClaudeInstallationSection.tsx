import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { DownloadIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

export function ClaudeInstallationSection({
  environmentId,
  instanceId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}) {
  const t = useUiTranslation();
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const start = useAtomCommand(serverEnvironment.startProviderInstall);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderInstall);
  const remove = useAtomCommand(serverEnvironment.removeProviderInstallation);
  const canStart = useAtomValue(
    serverEnvironment.startProviderInstall.permissionAtom(environmentId),
  );
  const canCancel = useAtomValue(
    serverEnvironment.cancelProviderInstall.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    serverEnvironment.removeProviderInstallation.permissionAtom(environmentId),
  );
  const state = query.data;
  const active =
    state?.phase === "downloading" || state?.phase === "extracting" || state?.phase === "verifying";
  const installed = provider?.installed || state?.installedVersion != null;
  return (
    <>
      <SettingsRow
        title={t("Claude installation")}
        description={
          query.error
            ? t("Could not read installation status. Reconnect and try again.")
            : state?.message
              ? t(state.message)
              : installed
                ? state?.installedVersion
                : t("Not installed")
        }
        control={
          <div className="flex flex-wrap justify-end gap-2">
            {active && state.operationId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || !canCancel}
                onClick={() =>
                  void cancel({
                    environmentId,
                    input: { instanceId, operationId: state.operationId! },
                  })
                }
              >
                <XIcon />
                {t("Cancel installation")}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={readOnly || !canStart || !provider?.setup?.canInstall}
                  onClick={() => void start(target)}
                >
                  {installed ? <RefreshCwIcon /> : <DownloadIcon />}
                  {t(installed ? "Update Claude" : "Install Claude")}
                </Button>
                {state?.canRemove ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readOnly || !canRemove}
                    onClick={() => void remove(target)}
                  >
                    <Trash2Icon />
                    {t("Remove installation")}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        }
      />
      <SettingsRow
        title={t("Binary path")}
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={t("Claude binary path")}
              value={state?.executablePath ?? ""}
              title={state?.executablePath ?? undefined}
              placeholder={t("Not installed")}
              disabled
            />
          </div>
        }
      />
    </>
  );
}
