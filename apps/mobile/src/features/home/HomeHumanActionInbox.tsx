import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectHumanActions,
  readHumanActionSnapshot,
  type ScopedHumanAction,
} from "@t3tools/client-runtime/state/human-action-inbox";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { useMessages } from "gt-react-native";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Sheet } from "../../components/ui/Sheet";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useProject, useQuietThreadShell, useServerConfigs } from "../../state/entities";
import {
  mobileInboxes,
  openableMobileHumanAction,
  type MobileHumanActionTarget,
} from "../../state/human-action-inbox";
import { useEnvironmentsWithScope } from "../../state/session";
import { useWorkspaceEnvironments } from "../../state/workspace";

function InboxRow({
  target,
  environmentLabel,
  onOpen,
}: {
  readonly target: ScopedHumanAction;
  readonly environmentLabel: string | undefined;
  readonly onOpen: (target: ScopedHumanAction) => void;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(target.environmentId, target.threadId));
  const project = useProject(scopeProjectRef(target.environmentId, target.projectId));
  const now = useNowMinuteMs();
  const t = useUiTranslation();
  const m = useMessages();
  const approval = target.kind === "approval";
  return (
    <ListActionRow
      label={approval ? t("Waiting for approval") : t("Waiting for your answer")}
      description={[thread?.title ?? t("Thread"), project?.title, environmentLabel]
        .filter(Boolean)
        .join(" · ")}
      detail={relativeTime(new Date(target.createdAt.epochMilliseconds).toISOString(), now, m)}
      icon={approval ? "exclamationmark.shield" : "bubble.left"}
      trailingIcon="chevron.right"
      onPress={() => onOpen(target)}
    />
  );
}

export function HomeHumanActionInbox({
  onOpenTarget,
}: {
  readonly onOpenTarget: (target: MobileHumanActionTarget) => void;
}) {
  const t = useUiTranslation();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | ScopedHumanAction["kind"]>("all");
  const environments = useWorkspaceEnvironments();
  const configs = useServerConfigs();
  const canRead = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const canOperate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const enabled = environments.filter((environment) => environment.isEnabled);
  const supported = enabled.filter(
    ({ environmentId }) =>
      canRead.has(environmentId) &&
      canOperate.has(environmentId) &&
      configs.get(environmentId)?.environment.capabilities.pendingHumanActions === true,
  );
  const connected = supported.filter(({ connectionState }) => connectionState === "connected");
  const results = useAtomValue(
    mobileInboxes(JSON.stringify(open ? connected.map(({ environmentId }) => environmentId) : [])),
  );
  const ready = connected.flatMap(({ environmentId }, index) => {
    const snapshot = readHumanActionSnapshot(results[index]);
    return snapshot ? [{ environmentId, targets: snapshot.targets }] : [];
  });
  const actions = collectHumanActions(ready);
  const visible = filter === "all" ? actions : actions.filter(({ kind }) => kind === filter);
  const incomplete = ready.length < enabled.length;
  if (!open && supported.length === 0) return null;

  const onOpen = (target: ScopedHumanAction) => {
    if (!openableMobileHumanAction(target)) {
      Alert.alert(t("This request is no longer available."));
      return;
    }
    setOpen(false);
    onOpenTarget({
      environmentId: target.environmentId,
      threadId: target.threadId,
      projectId: target.projectId,
      requestId: target.requestId,
      targetItemId: target.targetItemId,
      kind: target.kind,
    });
  };

  return (
    <>
      <View className="px-4 py-2">
        <ListSection>
          <ListActionRow
            label={t("Waiting for me")}
            icon="tray.and.arrow.down"
            trailingIcon="chevron.right"
            onPress={() => {
              setFilter("all");
              setOpen(true);
            }}
          />
        </ListSection>
      </View>
      {open ? (
        <Sheet title={t("Waiting for me")} onClose={() => setOpen(false)} expanded>
          <ScrollView contentInsetAdjustmentBehavior="automatic">
            <View className="gap-4 px-4 py-4">
              <AppText textRole="footnote" className="text-foreground-muted">
                {t(
                  "Shows supported approval and reply requests from directly connected environments. Linked work and other request types stay in their conversations.",
                )}
              </AppText>
              {incomplete ? (
                <AppText
                  accessibilityLiveRegion="polite"
                  textRole="footnote"
                  className="text-foreground-muted"
                >
                  {t("Some environments are unavailable. This list may be incomplete.")}
                </AppText>
              ) : null}
              <SegmentedControl
                role="tab"
                options={[
                  { value: "all", label: t("All") },
                  { value: "approval", label: t("Approvals") },
                  { value: "user_input", label: t("Questions") },
                ]}
                selected={filter}
                onSelect={setFilter}
              />
              {visible.length > 0 ? (
                <ListSection>
                  {visible.map((target) => (
                    <InboxRow
                      key={JSON.stringify([
                        target.environmentId,
                        target.threadId,
                        target.kind,
                        target.requestId,
                      ])}
                      target={target}
                      environmentLabel={
                        connected.find(
                          ({ environmentId }) => target.environmentId === environmentId,
                        )?.environmentLabel
                      }
                      onOpen={onOpen}
                    />
                  ))}
                </ListSection>
              ) : (
                <AppText textRole="footnote" className="text-foreground-muted">
                  {actions.length > 0
                    ? t("No requests match this filter.")
                    : incomplete
                      ? t("No requests from synchronized environments.")
                      : t("No supported pending approvals or questions.")}
                </AppText>
              )}
            </View>
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
}
