import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  CommandId,
  type EnvironmentId,
  type WorkItem,
  type WorkItemCommandInput,
  type IssueOption,
  type DeliverySummary,
} from "@t3tools/contracts";
import { DELIVERY_PROGRESS_LABELS } from "@t3tools/client-runtime/work-item";
import { useState } from "react";
import { Linking, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { uuidv4 } from "../../lib/uuid";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { IssuePicker } from "./IssuePicker";

export function RequirementDeliveryPanel({
  environmentId,
  item,
  summary,
  transitions = [],
}: {
  environmentId: EnvironmentId;
  item: WorkItem;
  summary?: DeliverySummary | undefined;
  transitions?: readonly IssueOption[];
}) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const allowed = useAtomValue(
    serverEnvironment.refreshWorkItemDelivery.permissionAtom(environmentId),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateWorkItem);
  const refresh = useAtomCommand(serverEnvironment.refreshWorkItemDelivery);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState("");
  const delivery = item.delivery;
  const run = async (input: WorkItemCommandInput) => {
    setBusy(true);
    await mutate({ environmentId, input });
    setBusy(false);
  };
  if (!delivery) return null;
  return (
    <View className="gap-3 border-t border-border-subtle py-4">
      <Button
        label={t("Refresh delivery")}
        icon="arrow.clockwise"
        disabled={!allowed || busy}
        onPress={async () => {
          setBusy(true);
          await refresh({ environmentId, input: { id: item.id } });
          setBusy(false);
        }}
      />
      <Text className="font-t3-semibold">{t("Delivery progress")}</Text>
      <Text>
        {summary
          ? t(
              summary.synced && summary.progress !== "delivery_exception"
                ? "Completed"
                : DELIVERY_PROGRESS_LABELS[summary.progress],
            )
          : t("Needs confirmation")}
      </Text>
      {delivery.syncError ? <Text className="text-danger">{t(delivery.syncError)}</Text> : null}
      {delivery.evidence.anomaly ? (
        <Text className="text-danger">{t(delivery.evidence.anomaly)}</Text>
      ) : null}
      {delivery.evidence.anomaly && transitions.length > 0 ? (
        <>
          <IssuePicker
            label={t("Reopen issue")}
            value={state}
            options={transitions}
            onChange={setState}
          />
          <Button
            label={t("Confirm reopen")}
            disabled={!allowed || busy || !state}
            onPress={async () => {
              setBusy(true);
              const result = await mutate({
                environmentId,
                input: {
                  type: "reopen_delivery",
                  commandId: CommandId.make(uuidv4()),
                  id: item.id,
                  expectedVersion: item.version,
                  state,
                },
              });
              if (result._tag === "Success")
                await refresh({ environmentId, input: { id: item.id } });
              setBusy(false);
            }}
          />
        </>
      ) : null}
      <Text className="font-t3-medium">{t("Linked conversations")}</Text>
      {item.sources.map((source) => (
        <View key={source.threadId} className="gap-2">
          <ListRow
            label={source.title}
            onPress={() =>
              navigation.dispatch(
                StackActions.push("Thread", { environmentId, threadId: source.threadId }),
              )
            }
          />
          <Button
            label={t("Unlink")}
            disabled={!allowed || busy}
            onPress={() =>
              void run({
                type: "unlink_issue_thread",
                commandId: CommandId.make(uuidv4()),
                id: item.id,
                expectedVersion: item.version,
                threadId: source.threadId,
              })
            }
          />
        </View>
      ))}
      <Text className="font-t3-medium">{t("Necessary pull requests")}</Text>
      {delivery.scope.requiredPullRequests.map((url) => (
        <ListRow
          key={url}
          label={url}
          description={t(
            delivery.evidence.pullRequests.some((pr) => pr.url === url && pr.merged)
              ? "Merged"
              : "Awaiting merge",
          )}
          onPress={() => void Linking.openURL(url)}
        />
      ))}
      {delivery.issue.provider === "meituan" ? (
        <>
          <Text className="font-t3-medium">{t("MCM releases")}</Text>
          {delivery.scope.changedServices.map((service) => (
            <Text key={`${service.appkey}/${service.target}/${service.revision}`}>
              {service.appkey} · {service.target} ·{" "}
              {t(
                delivery.evidence.releases.some(
                  (release) =>
                    release.completed &&
                    release.appkey === service.appkey &&
                    release.target === service.target &&
                    release.revision === service.revision,
                )
                  ? "Released"
                  : "Awaiting release",
              )}
            </Text>
          ))}
          {delivery.evidence.planIds.map((id) => (
            <Text key={id}>MCM #{id}</Text>
          ))}
        </>
      ) : null}
      {delivery.scope.confirmedRevision !== delivery.scope.revision &&
      delivery.scope.requiredPullRequests.length > 0 ? (
        <Button
          label={t("Confirm delivery scope")}
          disabled={!allowed || busy}
          onPress={() =>
            void run({
              type: "confirm_scope",
              commandId: CommandId.make(uuidv4()),
              id: item.id,
              expectedVersion: item.version,
              scopeRevision: delivery.scope.revision,
            })
          }
        />
      ) : null}
      {delivery.issue.provider === "meituan" && transitions.length > 0 ? (
        <>
          <IssuePicker
            label={t("Completed workflow state")}
            value={state}
            options={transitions.filter((transition) => transition.category === "DONE")}
            onChange={setState}
          />
          <Button
            label={t("Save")}
            disabled={!allowed || busy || !state}
            onPress={() =>
              void run({
                type: "completion_state",
                commandId: CommandId.make(uuidv4()),
                id: item.id,
                expectedVersion: item.version,
                state,
              })
            }
          />
        </>
      ) : null}
    </View>
  );
}
