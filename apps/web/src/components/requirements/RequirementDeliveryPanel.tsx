import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
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
import { DELIVERY_PROGRESS_LABELS, pullRequestLabel } from "@t3tools/client-runtime/work-item";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { IssueSelect } from "./IssueSelect";
import { RefreshCwIcon, UnlinkIcon, MessageSquareIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DeliveryStages } from "./DeliveryStages";

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
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">{t("Delivery progress")}</h3>
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
      <DeliveryStages provider={delivery.issue.provider} summary={summary} />
      <div>
        <p className="text-xs text-muted-foreground">
          {summary
            ? t(
                summary.synced && summary.progress === "delivery_complete"
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
      {item.sources.length > 0 ? (
        <details className="border-t border-border/60 pt-3">
          <summary className="cursor-pointer text-xs font-medium">
            {t("Linked conversations")}{" "}
            <span className="text-muted-foreground">{item.sources.length}</span>
          </summary>
          <div className="mt-2 space-y-1">
            {item.sources.map((source) => (
              <div key={source.threadId} className="flex min-w-0 items-center gap-2">
                <Link
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 text-xs hover:underline"
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: source.threadId }}
                >
                  <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{source.title}</span>
                </Link>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("Unlink")}
                  title={t("Unlink")}
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
                  <UnlinkIcon />
                </Button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <div className="space-y-2 border-t border-border/60 pt-4">
        <h3 className="text-xs font-medium">
          {t("Necessary pull requests")}{" "}
          <span className="font-normal text-muted-foreground">
            {summary?.mergedPullRequests ?? 0}/{delivery.scope.requiredPullRequests.length}
          </span>
        </h3>
        {!delivery.scope.requiredPullRequests.length ? (
          <p className="text-xs text-muted-foreground">{t("No pull requests linked yet.")}</p>
        ) : null}
        {delivery.scope.requiredPullRequests.map((url) => (
          <div
            key={url}
            className="flex min-h-10 min-w-0 items-center justify-between gap-2 text-xs"
          >
            <PullRequestGlyph.pullRequest className="size-3.5 shrink-0 text-muted-foreground" />
            <a
              className="min-w-0 flex-1 wrap-anywhere hover:underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {pullRequestLabel(url)}
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
        <div className="space-y-2 border-t border-border/60 pt-4">
          <h3 className="text-xs font-medium">{t("MCM releases")}</h3>
          {delivery.scope.changedServices.map((service) => (
            <div
              key={`${service.appkey}/${service.target}/${service.revision}`}
              className="flex min-h-10 min-w-0 items-start justify-between gap-2 text-xs"
            >
              <span className="min-w-0 break-all">
                {service.appkey}
                <span className="mt-1 block text-2xs text-muted-foreground">
                  {service.target} · {service.revision}
                </span>
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
        <details className="border-t border-border/60 pt-3">
          <summary className="cursor-pointer text-xs font-medium">
            {t("Completed workflow state")}
          </summary>
          <div className="mt-3 space-y-2">
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
        </details>
      ) : null}
      {delivery.lastSyncedAt ? (
        <p className="text-2xs text-muted-foreground">
          {t("Last synced")}: {new Date(delivery.lastSyncedAt).toLocaleString()}
        </p>
      ) : null}
    </section>
  );
}
