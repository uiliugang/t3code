import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type WorkItemId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { uuidv4 } from "../../lib/uuid";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { IssuePicker } from "./IssuePicker";

export function ThreadIssueCreationButton({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const config = useEnvironmentServerConfig(environmentId);
  const allowed = useAtomValue(serverEnvironment.createWorkItemIssue.permissionAtom(environmentId));
  const sources = useEnvironmentQuery(
    sourceControlEnvironment.issueSources({ environmentId, input: { projectIds: [projectId] } }),
  );
  const create = useAtomCommand(serverEnvironment.createWorkItemIssue);
  const commandId = useRef(CommandId.make(uuidv4()));
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [itemId, setItemId] = useState<WorkItemId | null>(null);
  const task = useEnvironmentQuery(
    itemId ? serverEnvironment.workItemsLive({ environmentId, input: { id: itemId } }) : null,
  );
  const linked = useEnvironmentQuery(
    config?.workItemDelivery
      ? serverEnvironment.workItemsLive({ environmentId, input: { threadId } })
      : null,
  );
  const options = sources.data?.[0]?.sources ?? [];
  const source =
    options.length === 1 ? options[0] : selected ? options[Number(selected)] : undefined;
  if (!config?.workItemDelivery) return null;
  if (linked.data?.items.some((item) => item.issue)) return null;
  if (itemId)
    return (
      <View className="gap-2">
        <Text className="text-xs text-foreground-muted">{t("Preparing issue creation")}</Text>
        {task.data?.item?.executions.at(-1) ? (
          <Button
            label={t("Open conversation")}
            onPress={() =>
              navigation.dispatch(
                StackActions.push("Thread", {
                  environmentId,
                  threadId: task.data?.item?.executions.at(-1)?.threadId,
                }),
              )
            }
          />
        ) : null}
      </View>
    );
  return (
    <View className="gap-2">
      {options.length > 1 ? (
        <IssuePicker
          label={t("Issue source")}
          value={selected}
          options={[
            { value: "", label: t("Choose issue source") },
            ...options.map((source, index) => ({
              value: String(index),
              label: `${source.provider === "meituan" ? "MEP ONES" : "GitHub"} · ${source.scope}`,
            })),
          ]}
          onChange={setSelected}
        />
      ) : null}
      <Button
        label={t("Create issue")}
        icon="plus"
        disabled={!allowed || busy || !source}
        onPress={() => {
          if (!source) return;
          setBusy(true);
          setFailed(false);
          void create({
            environmentId,
            input: { commandId: commandId.current, threadId, source },
          }).then((result) => {
            setBusy(false);
            if (result._tag === "Success") setItemId(result.value.item.id);
            else setFailed(true);
          });
        }}
      />
      {sources.error ? <Text className="text-danger">{sources.error}</Text> : null}
      {failed ? <Text className="text-danger">{t("Could not create issue.")}</Text> : null}
    </View>
  );
}
