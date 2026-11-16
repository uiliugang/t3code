import { useAtomValue } from "@effect/atom-react";
import { sourceControlToolStatus } from "@t3tools/client-runtime/state/source-control";
import type { SourceControlTool } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";

import * as Dialog from "../../../components/ui/Dialog";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import { useEnvironmentQuery } from "../../../state/query";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function SourceControlToolsSection({
  environment,
}: {
  readonly environment: SettingsTarget;
}) {
  const t = useUiTranslation();
  const environmentId = environment.environmentId;
  const supported =
    environment.serverConfig.environment.capabilities.sourceControlToolMaintenance === true;
  const tools = useEnvironmentQuery(
    supported ? sourceControlEnvironment.tools({ environmentId, input: {} }) : null,
  );
  const discovery = useEnvironmentQuery(
    supported ? sourceControlEnvironment.discovery({ environmentId, input: {} }) : null,
  );
  const start = useAtomCommand(sourceControlEnvironment.startTool, { reportFailure: false });
  const refresh = useAtomCommand(sourceControlEnvironment.refreshTools);
  const canMaintain = useAtomValue(
    sourceControlEnvironment.startTool.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState(false);
  const busy =
    pending ||
    (tools.data?.some((tool) => tool.phase === "running" || tool.phase === "verifying") ?? false);
  const completedTools =
    tools.data
      ?.filter((tool) => ["succeeded", "unchanged", "failed"].includes(tool.phase))
      .map((tool) => `${tool.id}:${tool.phase}:${tool.version}`)
      .join(",") ?? "";
  const refreshDiscovery = discovery.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installer events invalidate the server's separate tool and authentication discovery query
  useEffect(() => {
    if (completedTools) refreshDiscovery();
  }, [completedTools, refreshDiscovery]);

  const install = async (tool: SourceControlTool) => {
    if (!tool.command || pending) return;
    setPending(true);
    const result = await start({
      environmentId,
      input: {
        id: tool.id,
        expectedCommand: tool.command,
        expectedVersion: tool.version,
        expectedPath: tool.executablePath,
      },
    });
    setPending(false);
    if (result._tag !== "Success") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        t("Installation failed."),
        t(error instanceof Error ? error.message : "Installation failed."),
      );
    }
  };
  const confirm = (tool: SourceControlTool) => {
    const command = tool.command ?? tool.manualCommand;
    Dialog.alert(
      t(
        tool.command
          ? tool.version
            ? "Update {name}"
            : "Install {name}"
          : "Manage {name} on the server",
        { name: tool.label },
      ),
      [
        t("Target environment: {name}", { name: environment.label }),
        `${t("Current version")}: ${tool.version ?? t(tool.status === "missing" ? "Not installed" : "Unknown")}`,
        `${t("Executable path")}: ${tool.executablePath ?? t(tool.status === "missing" ? "Not installed" : "Unknown")}`,
        tool.reason ? t(tool.reason) : null,
        command,
      ]
        .filter(Boolean)
        .join("\n\n"),
      [
        { text: t("Cancel"), style: "cancel" },
        ...(command
          ? [
              {
                text: t("Copy command"),
                onPress: () =>
                  void Clipboard.setStringAsync(command).catch(() =>
                    Dialog.alert(t("Could not copy command.")),
                  ),
              },
            ]
          : []),
        ...(tool.command && canMaintain
          ? [{ text: t(tool.version ? "Update" : "Install"), onPress: () => void install(tool) }]
          : []),
      ],
    );
  };
  if (!supported) return null;
  return (
    <SettingsSection title={`${t("Source control tools")} · ${environment.label}`}>
      {tools.data?.map((tool) => (
        <SettingsRow
          key={tool.id}
          icon={
            tool.command === null
              ? "wrench.and.screwdriver"
              : tool.version
                ? "arrow.up.circle"
                : "arrow.down.circle"
          }
          label={tool.label}
          value={[tool.version, t(sourceControlToolStatus(tool))].filter(Boolean).join(" · ")}
          valuePosition="below"
          disabled={busy || (tool.command !== null && !canMaintain)}
          onPress={() => confirm(tool)}
        />
      ))}
      <SettingsRow
        icon="arrow.clockwise"
        label={t("Rescan server environment")}
        value={tools.error ?? undefined}
        valuePosition="below"
        disabled={busy || (tools.isPending && tools.data === null)}
        onPress={() => {
          void refresh({ environmentId, input: {} });
          discovery.refresh();
        }}
      />
    </SettingsSection>
  );
}
