import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  CommandId,
  type EnvironmentId,
  type IssueSource,
  type ProjectId,
  type ThreadId,
  type WorkItemId,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { IssueSelect } from "./IssueSelect";

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
  const sources = useEnvironmentQuery(
    sourceControlEnvironment.issueSources({ environmentId, input: { projectIds: [projectId] } }),
  );
  const allowed = useAtomValue(serverEnvironment.createWorkItemIssue.permissionAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const create = useAtomCommand(serverEnvironment.createWorkItemIssue);
  const commandId = useRef(CommandId.make(randomUUID()));
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [itemId, setItemId] = useState<WorkItemId | null>(null);
  const task = useEnvironmentQuery(
    itemId ? serverEnvironment.workItemsLive({ environmentId, input: { id: itemId } }) : null,
  );
  const linked = useEnvironmentQuery(
    config?.workItemDelivery === true
      ? serverEnvironment.workItemsLive({ environmentId, input: { threadId } })
      : null,
  );
  const options = sources.data?.[0]?.sources ?? [];
  const run = async (source: IssueSource) => {
    setBusy(true);
    setFailed(false);
    const result = await create({
      environmentId,
      input: { commandId: commandId.current, threadId, source },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setItemId(result.value.item.id);
      setChoosing(false);
    } else setFailed(true);
  };
  if (config?.workItemDelivery !== true) return null;
  if (!itemId && linked.data?.items.some((item) => item.issue)) return null;
  if (task.data?.item?.delivery)
    return (
      <a
        className="text-xs text-primary underline"
        href={task.data.item.delivery.issue.url}
        target="_blank"
        rel="noreferrer"
      >
        {t("Linked issues")} #{task.data.item.delivery.issue.id}
      </a>
    );
  if (itemId)
    return (
      <div className="space-y-2 text-xs text-muted-foreground" role="status">
        {t("Preparing issue creation")}
        {task.data?.item?.executions.at(-1) ? (
          <Link
            className="block text-primary underline"
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: task.data.item.executions.at(-1)!.threadId }}
          >
            {t("Open conversation")}
          </Link>
        ) : null}
      </div>
    );
  return (
    <div className="space-y-2">
      {choosing ? (
        <div className="min-w-0">
          <IssueSelect
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
        </div>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        disabled={!allowed || busy || options.length === 0 || (choosing && selected === "")}
        onClick={() => {
          if (options.length === 1) void run(options[0]!);
          else if (!choosing) setChoosing(true);
          else if (options[Number(selected)]) void run(options[Number(selected)]!);
        }}
      >
        <PlusIcon />
        {t("Create issue")}
      </Button>
      {sources.error ? (
        <p role="alert" className="text-xs text-destructive">
          {sources.error}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {t("Could not create issue.")}
        </p>
      ) : null}
    </div>
  );
}
