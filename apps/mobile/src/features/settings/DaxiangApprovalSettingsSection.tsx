import { useState } from "react";
import { msg } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
import type { DaxiangApprovalStatus, EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

type MonitorSettings = ServerSettings["daxiang"]["approvalMonitor"];
type MonitorPatch = Partial<MonitorSettings>;

const statusMessages: Record<DaxiangApprovalStatus, string> = {
  disabled: msg("Monitoring disabled"),
  missing_cli: msg("dumbo-web is not installed"),
  unauthenticated: msg("DaXiang login required"),
  connecting: msg("Connecting to DaXiang"),
  listening: msg("Listening for approval links"),
  error: msg("Listener error"),
};
const outcomeMessages = {
  approved: msg("approved"),
  notified: msg("notified"),
  opened: msg("Browser opened"),
  localOnly: msg("Recorded locally only"),
  deliveryUnknown: msg("Delivery unknown"),
  skipped: msg("skipped"),
  failed: msg("failed"),
} as const;

export function DaxiangApprovalSettingsSection({
  environmentId,
  disabled = false,
}: {
  environmentId: EnvironmentId;
  disabled?: boolean;
}) {
  const t = useUiTranslation();
  const monitor = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.daxiang
    .approvalMonitor;
  const allowed =
    useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId)) && !disabled;
  const canMutate =
    useAtomValue(serverEnvironment.mutateDaxiangApproval.permissionAtom(environmentId)) &&
    !disabled;
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const mutate = useAtomCommand(serverEnvironment.mutateDaxiangApproval, { reportFailure: false });
  const query = useEnvironmentQuery(
    serverEnvironment.daxiangApproval({ environmentId, input: {} }),
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [port, setPort] = useState<string | null>(null);
  const [prComment, setPrComment] = useState<string | null>(null);
  const [mcmComment, setMcmComment] = useState<string | null>(null);
  if (!monitor) return null;
  const state = query.data;
  const portValue = port ?? String(monitor.chromeCdpPort);
  const portNumber = Number(portValue);
  const validPort = /^\d+$/u.test(portValue) && portNumber >= 1 && portNumber <= 65535;

  const save = async (patch: MonitorPatch) => {
    if (!allowed || busy) return;
    setBusy(true);
    setFailed(false);
    const result = await update({
      environmentId,
      input: { patch: { daxiang: { approvalMonitor: patch } } },
    });
    setBusy(false);
    setFailed(result._tag !== "Success");
    if (result._tag === "Success") query.refresh();
  };
  const run = async (
    input: { type: "restart" | "clear_records" } | { type: "login"; port: number },
  ) => {
    if (!canMutate || busy) return;
    if (input.type === "login" && !validPort) return;
    setBusy(true);
    setFailed(false);
    const result = await mutate({ environmentId, input });
    setBusy(false);
    setFailed(result._tag !== "Success");
    query.refresh();
  };
  const toggle = (key: keyof MonitorSettings, label: string, subtitle: string) => (
    <SettingsSwitchRow
      label={t(label)}
      subtitle={t(subtitle)}
      value={Boolean(monitor[key])}
      disabled={!allowed || busy}
      onValueChange={(value) => void save({ [key]: value } as MonitorPatch)}
    />
  );

  return (
    <>
      <SettingsSection title={t("Approval link monitoring")}>
        <SettingsSwitchRow
          label={t("Enable approval link monitoring")}
          subtitle={t(
            "Listen through dumbo-web. PR and MCM use official CLIs; Lion, RDS and DMS remain manual.",
          )}
          value={monitor.enabled}
          disabled={!allowed || busy}
          onValueChange={(value) => void save({ enabled: value })}
        />
        <SettingsRow
          icon="doc.text"
          label={t("Listener status")}
          value={state ? t(statusMessages[state.status]) : t("Loading...")}
          valuePosition="below"
        />
        <View className="gap-3 p-4">
          <ConnectionFormField
            label={t("Chrome CDP port")}
            value={port ?? String(monitor.chromeCdpPort)}
            keyboardType="number-pad"
            autoCapitalize="none"
            autoCorrect={false}
            editable={allowed && !busy}
            onChangeText={(value) => setPort(value.replace(/\D/gu, "").slice(0, 5))}
            onBlur={() => {
              const value = Number(port ?? monitor.chromeCdpPort);
              if (value >= 1 && value <= 65535 && value !== monitor.chromeCdpPort) {
                void save({ chromeCdpPort: value });
              }
              setPort(null);
            }}
          />
          <Text className="text-sm text-foreground-muted">
            {t(
              "Open x.sankuai.com in a dedicated Chrome session with this loopback debugging port, finish SSO, then import.",
            )}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={t("Import DaXiang login")}
              disabled={!canMutate || busy || !validPort}
              loading={busy}
              onPress={() => void run({ type: "login", port: portNumber })}
            />
            <Button
              label={t("Restart listener")}
              tone="secondary"
              disabled={!canMutate || busy}
              onPress={() => void run({ type: "restart" })}
            />
          </View>
          {state?.error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {state.error}
            </Text>
          ) : null}
        </View>
        {toggle(
          "includeGroupChats",
          "Include group chats",
          "Also process approval links received in groups. Direct messages and approval bot messages are always included.",
        )}
        {toggle(
          "autoApprovePullRequest",
          "Automatically approve pull requests",
          "Check the PR, add yourself as a reviewer when needed, comment, then approve. Never merge.",
        )}
        <View className="p-4">
          <ConnectionFormField
            label={t("PR review comment")}
            value={prComment ?? monitor.pullRequestComment}
            autoCapitalize="none"
            autoCorrect={false}
            editable={allowed && !busy}
            onChangeText={setPrComment}
            onBlur={() => {
              const value = (prComment ?? monitor.pullRequestComment).trim() || "LGTM";
              if (value !== monitor.pullRequestComment) {
                void save({ pullRequestComment: value });
              }
              setPrComment(null);
            }}
          />
        </View>
        {toggle(
          "autoApproveMcm",
          "Automatically approve MCM plans and events",
          "Verify the pending state and current MCM plan level before approving. Never execute the change itself.",
        )}
        <View className="p-4">
          <ConnectionFormField
            label={t("MCM approval comment")}
            value={mcmComment ?? monitor.mcmApproveComment}
            autoCapitalize="none"
            autoCorrect={false}
            editable={allowed && !busy}
            onChangeText={setMcmComment}
            onBlur={() => {
              const value = (mcmComment ?? monitor.mcmApproveComment).trim() || "自动审批通过";
              if (value !== monitor.mcmApproveComment) {
                void save({ mcmApproveComment: value });
              }
              setMcmComment(null);
            }}
          />
        </View>
        {toggle(
          "notifyUnsupportedLinks",
          "Remind me about manual approvals",
          "Notify and keep a record for Lion, RDS, DMS, or automatic approvals switched off.",
        )}
        {toggle(
          "autoOpenUnsupportedInBrowser",
          "Open manual approvals in the browser",
          "Open manual links on the server. No approval button is clicked automatically.",
        )}
        {toggle(
          "replyOnHandled",
          "Reply to the sender",
          "Send a short DaXiang reply after an approval or manual reminder when the chat supports replies.",
        )}
        {failed ? (
          <Text accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">
            {t("Could not update the approval listener. Check its settings and try again.")}
          </Text>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("Recent approval activity")}>
        {state?.records.length ? (
          <>
            {state.records.slice(0, 8).map((record) => (
              <SettingsRow
                key={record.id}
                icon="doc.text"
                label={record.title}
                value={`${t(outcomeMessages[record.outcome])} · ${record.detail ?? ""}`}
                valuePosition="below"
                onPress={() => void tryOpenExternalUrl(record.url)}
              />
            ))}
            <View className="p-4">
              <Button
                label={t("Clear")}
                tone="secondary"
                disabled={!canMutate || busy}
                onPress={() => void run({ type: "clear_records" })}
              />
            </View>
          </>
        ) : (
          <View className="p-4">
            <Text className="text-sm text-foreground-muted">{t("No approval activity yet.")}</Text>
          </View>
        )}
      </SettingsSection>
    </>
  );
}
