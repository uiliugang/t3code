import { useAtomValue } from "@effect/atom-react";
import {
  SourceControlProviderKind,
  isMeituanServiceEnabled,
  type EnvironmentId,
} from "@t3tools/contracts";
import { readMeituanCodeMis as readMis } from "@t3tools/client-runtime/source-control-clients";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const input = { provider: SourceControlProviderKind.make("meituan"), host: "git.sankuai.com" };

export function MeituanCodeSettingsSection(props: {
  readonly environment: SettingsTarget;
  readonly disabled: boolean;
  readonly multiple: boolean;
  readonly initialExpanded?: boolean;
}) {
  const t = useUiTranslation();
  const environmentId = props.environment.environmentId;
  const discovery = useEnvironmentQuery(
    isMeituanServiceEnabled(props.environment.serverConfig.settings, "sourceControl")
      ? sourceControlEnvironment.discovery({ environmentId, input: {} })
      : null,
  );
  const item = discovery.data?.sourceControlProviders.find((entry) => entry.kind === "meituan");
  const saved = props.environment.serverConfig.settings.sourceControlHosts.meituan;
  const savedMis = readMis(saved);
  const [expanded, setExpanded] = useState(props.initialExpanded ?? false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSignIn = useAtomValue(
    sourceControlEnvironment.startSignIn.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.cancelSignIn, { reportFailure: false });
  const pending = item?.authorization?.status === "pending";
  const authenticated = item?.auth.status === "authenticated";
  const observe = useEffectEvent(async (environmentId: EnvironmentId, active: () => boolean) => {
    await wait({ environmentId, input });
    if (active()) discovery.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for the server-owned authorization to finish and refreshes discovery without polling
  useEffect(() => {
    if (!pending || !canSignIn) return;
    let active = true;
    void observe(environmentId, () => active);
    return () => {
      active = false;
    };
  }, [environmentId, pending, canSignIn]);
  const value = draft ?? savedMis;
  const mis = readMis({ mis: value });
  const dirty = value.trim() !== savedMis;
  const errorMessage = error ?? (authenticated ? null : item?.authorization?.detail);
  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { patch: { sourceControlHosts: { meituan: { mis } } } },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setDraft(null);
      discovery.refresh();
    } else setError(t("Could not save the MIS ID. Try again."));
  };
  const request = async () => {
    setBusy(true);
    setError(null);
    const result = await (pending ? cancel : start)({ environmentId, input });
    setBusy(false);
    if (result._tag !== "Success")
      setError(t("Could not start authorization. Rescan the server and try again."));
    discovery.refresh();
  };
  return (
    <SettingsSection
      title={
        props.multiple
          ? t("Meituan Code · {account}", { account: props.environment.label })
          : t("Meituan Code")
      }
    >
      <SettingsRow
        icon="person.crop.circle"
        label={t("Meituan Code")}
        value={t(
          pending
            ? "Signing in with MOA…"
            : authenticated
              ? "Authenticated"
              : item?.auth.status === "unauthenticated"
                ? "Not authenticated"
                : "Status unknown",
        )}
        onPress={() => setExpanded((open) => !open)}
      />
      {expanded ? (
        <>
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm text-foreground">{t("MIS ID")}</Text>
            <AppTextInput
              accessibilityLabel={t("MIS ID")}
              value={value}
              onChangeText={setDraft}
              placeholder={t("Enter your MIS ID")}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={64}
              editable={!props.disabled && !busy && !pending}
              className="min-h-11 rounded-xl border border-border px-3 py-2 text-base text-foreground"
            />
            <Text className="text-sm text-foreground-muted">
              {t(
                value.trim() && !mis
                  ? "Use letters, numbers, dots, underscores or hyphens, starting with a letter."
                  : "MIS ID for DaXiang approval reminders. Not used for sign-in.",
              )}
            </Text>
            {errorMessage ? (
              <Text accessibilityRole="alert" className="text-sm text-destructive">
                {t(errorMessage)}
              </Text>
            ) : null}
          </View>
          <SettingsRow
            icon="checkmark"
            label={t("Save")}
            disabled={props.disabled || busy || pending || !dirty || Boolean(value.trim() && !mis)}
            onPress={() => void save()}
          />
          {!authenticated || pending ? (
            <SettingsRow
              icon="person.crop.circle"
              label={t(pending ? "Cancel sign-in" : "Sign in with MOA")}
              disabled={!canSignIn || busy || (!pending && item?.status !== "available")}
              onPress={() => void request()}
            />
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
