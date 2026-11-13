import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  CommandId,
  type EnvironmentId,
  type WorkItem,
  type WorkItemCommandInput,
  type DeliverySummary,
  type IssueOption,
} from "@t3tools/contracts";
import { DELIVERY_PROGRESS_LABELS } from "@t3tools/client-runtime/work-item";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { IssueSelect } from "./IssueSelect";
import { RefreshCwIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
  const allowed = useAtomValue(
    serverEnvironment.refreshWorkItemDelivery.permissionAtom(environmentId),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateWorkItem);
  const refresh = useAtomCommand(serverEnvironment.refreshWorkItemDelivery);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState("");
  const delivery = item.delivery;
  if (!delivery) return null;
  const run = async (input: WorkItemCommandInput) => {
    setBusy(true);
    await mutate({ environmentId, input });
    setBusy(false);
  };
  return (
    <section className="space-y-4 border-t border-border py-4">
      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("Refresh delivery")}
                disabled={!allowed || busy}
                onClick={async () => {
                  setBusy(true);
                  await refresh({ environmentId, input: { id: item.id } });
                  setBusy(false);
                }}
              />
            }
          >
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipPopup>{t("Refresh delivery")}</TooltipPopup>
        </Tooltip>
      </div>
      <div>
        <h3 className="text-sm font-medium">{t("Delivery progress")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {summary
            ? t(
                summary.synced && summary.progress !== "delivery_exception"
                  ? "Completed"
                  : DELIVERY_PROGRESS_LABELS[summary.progress],
              )
            : t("Needs confirmation")}
        </p>
      </div>
      {delivery.syncError ? (
        <p role="alert" className="text-xs text-destructive">
          {t(delivery.syncError)}
        </p>
      ) : null}
      {delivery.evidence.anomaly ? (
        <p role="alert" className="text-xs text-destructive">
          {t(delivery.evidence.anomaly)}
        </p>
      ) : null}
      {delivery.evidence.anomaly && transitions.length > 0 ? (
        <div className="space-y-2">
          <IssueSelect
            label={t("Reopen issue")}
            value={state}
            options={[{ value: "", label: t("Choose reopened state") }, ...transitions]}
            onChange={setState}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!allowed || busy || !state}
            onClick={async () => {
              setBusy(true);
              const result = await mutate({
                environmentId,
                input: {
                  type: "reopen_delivery",
                  commandId: CommandId.make(randomUUID()),
                  id: item.id,
                  expectedVersion: item.version,
                  state,
                },
              });
              if (result._tag === "Success")
                await refresh({ environmentId, input: { id: item.id } });
              setBusy(false);
            }}
          >
            {t("Confirm reopen")}
          </Button>
        </div>
      ) : null}
      <div className="space-y-2">
        <h3 className="text-xs font-medium">{t("Linked conversations")}</h3>
        {item.sources.map((source) => (
          <div key={source.threadId} className="flex min-w-0 items-center gap-2">
            <Link
              className="min-w-0 flex-1 truncate text-xs text-primary hover:underline"
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: source.threadId }}
            >
              {source.title}
            </Link>
            <Button
              size="xs"
              variant="ghost"
              disabled={!allowed || busy}
              onClick={() =>
                void run({
                  type: "unlink_issue_thread",
                  id: item.id,
                  expectedVersion: item.version,
                  commandId: CommandId.make(randomUUID()),
                  threadId: source.threadId,
                })
              }
            >
              {t("Unlink")}
            </Button>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <h3 className="text-xs font-medium">{t("Necessary pull requests")}</h3>
        {delivery.scope.requiredPullRequests.map((url) => (
          <div key={url} className="flex min-w-0 items-start justify-between gap-2 text-xs">
            <a
              className="min-w-0 break-all text-primary hover:underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {url}
            </a>
            <span className="shrink-0 text-muted-foreground">
              {t(
                delivery.evidence.pullRequests.some((pr) => pr.url === url && pr.merged)
                  ? "Merged"
                  : "Awaiting merge",
              )}
            </span>
          </div>
        ))}
      </div>
      {delivery.issue.provider === "meituan" ? (
        <div className="space-y-2">
          <h3 className="text-xs font-medium">{t("MCM releases")}</h3>
          {delivery.scope.changedServices.map((service) => (
            <div
              key={`${service.appkey}/${service.target}/${service.revision}`}
              className="flex min-w-0 items-start justify-between gap-2 text-xs"
            >
              <span className="min-w-0 break-all">
                {service.appkey} · {service.target}
              </span>
              <span className="shrink-0 text-muted-foreground">
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
              </span>
            </div>
          ))}
          {delivery.evidence.planIds.map((id) => (
            <p key={id} className="text-xs text-muted-foreground">
              MCM #{id}
            </p>
          ))}
        </div>
      ) : null}
      {delivery.scope.confirmedRevision !== delivery.scope.revision &&
      delivery.scope.requiredPullRequests.length > 0 ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!allowed || busy}
          onClick={() =>
            void run({
              type: "confirm_scope",
              commandId: CommandId.make(randomUUID()),
              id: item.id,
              expectedVersion: item.version,
              scopeRevision: delivery.scope.revision,
            })
          }
        >
          {t("Confirm delivery scope")}
        </Button>
      ) : null}
      {delivery.issue.provider === "meituan" && transitions.length > 0 ? (
        <div className="space-y-2">
          <IssueSelect
            label={t("Completed workflow state")}
            value={state}
            options={[
              { value: "", label: t("Choose completed state") },
              ...transitions.filter((transition) => transition.category === "DONE"),
            ]}
            onChange={setState}
          />
          <Button
            size="xs"
            disabled={!allowed || busy || !state}
            onClick={() =>
              void run({
                type: "completion_state",
                commandId: CommandId.make(randomUUID()),
                id: item.id,
                expectedVersion: item.version,
                state,
              })
            }
          >
            {t("Save")}
          </Button>
        </div>
      ) : null}
      {delivery.lastSyncedAt ? (
        <p className="text-2xs text-muted-foreground">
          {t("Last synced")}: {new Date(delivery.lastSyncedAt).toLocaleString()}
        </p>
      ) : null}
    </section>
  );
}
