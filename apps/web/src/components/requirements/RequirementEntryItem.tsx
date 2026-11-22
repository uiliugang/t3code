import type { EnvironmentRequirementEntry } from "@t3tools/client-runtime/state/requirement-board";
import {
  DELIVERY_PROGRESS_LABELS,
  requirementTrackerLabel,
} from "@t3tools/client-runtime/work-item";
import {
  AlertTriangleIcon,
  BotIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  MessageSquareIcon,
  ServerIcon,
} from "lucide-react";

import { RelativeTime } from "~/components/RelativeTime";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { cn } from "~/lib/utils";
import { IssueStateGlyph, issueTrackerPresentation } from "../issue/issuePresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  PullRequestActorAvatar,
  PullRequestLabelChip,
} from "../pullRequest/pullRequestPresentation";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectTag } from "./ProjectTag";

function LocalStatusGlyph({
  entry,
}: {
  entry: Extract<EnvironmentRequirementEntry, { kind: "local" }>;
}) {
  const t = useUiTranslation();
  const label = t(entry.state);
  const Icon =
    entry.group === "attention"
      ? AlertTriangleIcon
      : entry.group === "done"
        ? CircleCheckIcon
        : entry.item.status === "todo"
          ? CircleDashedIcon
          : CircleDotIcon;
  const toneClassName =
    entry.group === "attention"
      ? "text-destructive"
      : entry.group === "done"
        ? "text-success"
        : entry.item.status === "todo"
          ? "text-muted-foreground"
          : "text-info";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Icon role="img" aria-label={label} className={cn("size-4 shrink-0", toneClassName)} />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function RequirementEntryItem({
  entry,
  selected,
  view,
  environmentLabel,
  projectTitle,
  showEnvironment,
  onSelect,
}: {
  entry: EnvironmentRequirementEntry;
  selected: boolean;
  view: "list" | "board";
  environmentLabel: string;
  projectTitle: string;
  showEnvironment: boolean;
  onSelect: (entry: EnvironmentRequirementEntry) => void;
}) {
  const t = useUiTranslation();
  const tracker = entry.kind === "issue" ? issueTrackerPresentation(entry.provider) : null;
  const displayKey =
    entry.kind === "issue"
      ? (entry.issue.displayKey ?? `${entry.provider === "linear" ? "" : "#"}${entry.issue.id}`)
      : null;
  const derivedIssueState =
    entry.kind === "issue"
      ? (entry.issue.stateInfo ?? {
          category: entry.issue.stateCategory === "done" ? ("closed" as const) : ("open" as const),
          name: entry.state || "open",
        })
      : null;
  const assigneeActors = entry.kind === "issue" ? entry.issue.assigneeActors : undefined;
  const issueLabels = entry.kind === "issue" ? (entry.issue.labels ?? []) : [];
  const commentCount = entry.kind === "issue" ? (entry.issue.commentCount ?? 0) : 0;

  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(entry)}
      className={cn(
        "group/req-row flex w-full min-w-0 flex-col gap-2 rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected
          ? view === "board"
            ? "border border-ring/60 bg-accent shadow-xs"
            : "bg-accent"
          : view === "board"
            ? "border border-border/70 bg-card shadow-2xs hover:border-border hover:bg-accent/50"
            : "hover:bg-accent/60",
      )}
    >
      <span className="flex w-full min-w-0 items-start gap-2">
        <span className="mt-0.5 inline-flex shrink-0">
          {derivedIssueState ? (
            <IssueStateGlyph state={derivedIssueState} />
          ) : entry.kind === "local" ? (
            <LocalStatusGlyph entry={entry} />
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {entry.kind === "issue" && tracker ? (
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
              <tracker.Icon aria-hidden className="size-3 shrink-0" />
              <span>
                {view === "list" ? `${requirementTrackerLabel[entry.provider]} ` : ""}
                {displayKey}
              </span>
            </span>
          ) : null}
          <span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">{entry.title}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {entry.priority ? (
            <Badge
              size="sm"
              variant={entry.priority === "P0" || entry.priority === "P1" ? "warning" : "outline"}
            >
              {entry.priority}
            </Badge>
          ) : null}
          {assigneeActors && assigneeActors.length > 0 ? (
            <span className="flex items-center -space-x-1">
              {assigneeActors.slice(0, 3).map((actor) => (
                <PullRequestActorAvatar
                  key={actor.login}
                  actor={actor}
                  className="ring-1 ring-background"
                />
              ))}
            </span>
          ) : null}
          {commentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground tabular-nums">
              <MessageSquareIcon aria-hidden className="size-3" />
              {commentCount}
            </span>
          ) : null}
        </span>
      </span>

      <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 pl-6 text-xs text-muted-foreground">
        {showEnvironment ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex max-w-40 items-center gap-1 rounded border border-border/70 px-1.5 py-0.5" />
              }
            >
              <ServerIcon className="size-3 shrink-0" />
              <span className="truncate">{environmentLabel}</span>
            </TooltipTrigger>
            <TooltipPopup>
              {t("Environment")}: {environmentLabel}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <ProjectTag title={projectTitle} />
        {entry.kind === "local" ? (
          <>
            <span>{t("Local work item")}</span>
            <span className="inline-flex items-center gap-1 tabular-nums">
              <BotIcon aria-hidden className="size-3" />
              {entry.item.activeExecutionCount} {t("Active agents")}
            </span>
          </>
        ) : !assigneeActors?.length ? (
          <span className="min-w-0 truncate">
            {entry.issue.assignees.map((person) => person.label).join(", ") || t("Unassigned")}
          </span>
        ) : null}
        {issueLabels.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {issueLabels.slice(0, 3).map((label, index) => (
              <PullRequestLabelChip key={label.name} label={label}>
                {index === 2 && issueLabels.length > 3 ? (
                  <span className="shrink-0">+{issueLabels.length - 3}</span>
                ) : null}
              </PullRequestLabelChip>
            ))}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {entry.summary && entry.summary.requiredPullRequests > 0 ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <PullRequestGlyph.pullRequest className="size-3.5" />
              {entry.summary.mergedPullRequests}/{entry.summary.requiredPullRequests}
            </span>
          ) : null}
          <span
            className={
              entry.group === "attention"
                ? "font-medium text-destructive"
                : entry.group === "done"
                  ? "text-success"
                  : ""
            }
          >
            {entry.summary
              ? t(
                  entry.summary.synced && entry.summary.progress === "delivery_complete"
                    ? "Completed"
                    : DELIVERY_PROGRESS_LABELS[entry.summary.progress],
                )
              : entry.kind === "local"
                ? t(entry.state)
                : entry.state}
          </span>
          {entry.updatedAt ? (
            <span className="whitespace-nowrap text-2xs tabular-nums">
              <RelativeTime timestamp={entry.updatedAt} />
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
