import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  branchIssuePlaceholder,
  parseBranchIssueUrl,
  type BranchIssue,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  Link2Icon,
  PlusIcon,
  RefreshCwIcon,
  UnlinkIcon,
} from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { vcsEnvironment } from "../../state/vcs";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { groupBranchIssues, type IssueBranch } from "./branchIssueGroups";
import { BranchIssueAssociationContext } from "./branchIssueAssociation";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Link } from "@tanstack/react-router";

function BranchRow({
  target,
  issue,
  current,
  refresh,
}: {
  target: IssueBranch;
  issue?: BranchIssue;
  current: boolean;
  refresh: () => void;
}) {
  const t = useUiTranslation();
  const allowed = useAtomValue(
    sourceControlEnvironment.updateBranchIssues.permissionAtom(target.environmentId),
  );
  const update = useAtomCommand(sourceControlEnvironment.updateBranchIssues);
  const association = useContext(BranchIssueAssociationContext);
  const adding =
    association?.target?.environmentId === target.environmentId &&
    association.target.cwd === target.cwd &&
    association.target.branch === target.branch;
  function setAdding(open: boolean) {
    association?.setTarget(open ? target : null);
  }
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function mutate() {
    const link = issue?.url ?? url.trim();
    if (!issue && parseBranchIssueUrl(link)?.provider !== target.provider) {
      setError(t("Enter valid issue links for this repository's hosting platform."));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: target.environmentId,
      input: {
        cwd: target.cwd,
        branch: target.branch,
        urls: [link],
        action: issue ? "disassociate" : "associate",
      },
    });
    setBusy(false);
    refresh();
    if (result._tag === "Success") {
      setAdding(false);
      setUrl("");
    } else {
      const failure = squashAtomCommandFailure(result);
      setError(
        t(
          failure instanceof Error
            ? failure.message
            : "Some links could not be updated. Refresh and retry.",
        ),
      );
    }
  }
  return (
    <div className="border-t border-border/50 py-1.5">
      <div className="flex min-h-7 items-center gap-2">
        <GitBranchIcon
          className={
            current ? "size-3.5 shrink-0 text-primary" : "size-3.5 shrink-0 text-muted-foreground"
          }
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                className={
                  current
                    ? "min-w-0 flex-1 text-xs text-primary"
                    : "min-w-0 flex-1 text-xs text-muted-foreground"
                }
              />
            }
          >
            <MiddleTruncate value={target.branch} showTitle={false} />
          </TooltipTrigger>
          <TooltipPopup>
            <div>{target.branch}</div>
            <div>{target.cwd}</div>
          </TooltipPopup>
        </Tooltip>
        {!issue && !target.published ? (
          <span className="shrink-0 text-2xs text-muted-foreground">{t("Not pushed")}</span>
        ) : null}
        {issue || target.published ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={!allowed || busy}
                  aria-label={t(issue ? "Unlink issue" : "Link issues")}
                  onClick={() => (issue ? void mutate() : setAdding(!adding))}
                />
              }
            >
              {issue ? <UnlinkIcon /> : <PlusIcon />}
            </TooltipTrigger>
            <TooltipPopup>{t(issue ? "Unlink issue" : "Link issues")}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {adding ? (
        <form
          className="space-y-2 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate();
          }}
        >
          <Input
            size="sm"
            aria-label={t("Issue links")}
            placeholder={t(branchIssuePlaceholder(target.provider))}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={busy}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              {t("Cancel")}
            </Button>
            <Button size="xs" type="submit" disabled={busy || !allowed || !url.trim()}>
              {t(busy ? "Linking..." : "Link issues")}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function IssueCard({
  issue,
  branches,
  currentCwd,
  refresh,
}: {
  issue: BranchIssue;
  branches: readonly IssueBranch[];
  currentCwd: string | null;
  refresh: () => void;
}) {
  const t = useUiTranslation();
  const [expanded, setExpanded] = useLocalStorage(
    `branch-issue-expanded:${branches[0]?.environmentId}:${issue.url}`,
    branches.some((branch) => branch.cwd === currentCwd),
    Schema.Boolean,
  );
  return (
    <article className="overflow-hidden rounded-lg border border-border/65">
      <div className="-mr-px pl-3 pt-3 pb-2">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 pr-3 text-2xs text-muted-foreground">
          <span>
            {issue.provider === "meituan" ? "MEP" : issue.repository} · #{issue.id}
          </span>
          <span>{issue.state}</span>
          <span className="ml-auto">{t("{count} branches", { count: branches.length })}</span>
        </div>
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              className="min-w-0 text-left text-xs font-medium leading-6 wrap-anywhere hover:text-foreground/80 focus-visible:outline-2 focus-visible:outline-ring"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {issue.title}
            </button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("View original")}
                    render={<a href={issue.url} target="_blank" rel="noopener noreferrer" />}
                  />
                }
              >
                <ExternalLinkIcon />
              </TooltipTrigger>
              <TooltipPopup>{t("View original")}</TooltipPopup>
            </Tooltip>
          </div>
          <ThreadDetailsControl
            part="icon"
            aria-label={t(expanded ? "Collapse issue" : "Expand issue")}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDownIcon className={expanded ? "size-4 rotate-180" : "size-4"} />
          </ThreadDetailsControl>
        </div>
      </div>
      {expanded ? (
        <div className="-mr-px pl-3">
          {branches.map((branch) => (
            <BranchRow
              key={JSON.stringify([branch.cwd, branch.branch])}
              target={branch}
              issue={issue}
              current={branch.cwd === currentCwd}
              refresh={refresh}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function GroupedBranchIssuesPanel({
  environmentId,
  cwds,
  currentCwd,
  creationControl,
  threadId,
}: {
  environmentId: EnvironmentId;
  cwds: readonly string[];
  currentCwd: string | null;
  creationControl?: ReactNode;
  threadId?: ThreadId;
}) {
  const t = useUiTranslation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const linked = useEnvironmentQuery(
    threadId && config?.workItemDelivery === true
      ? serverEnvironment.workItemsLive({ environmentId, input: { threadId } })
      : null,
  );
  const threadIssues = (linked.data?.items ?? []).filter((item) => item.issue);
  const registry = useContext(RegistryContext);
  const showEmpty = useClientSettings((settings) => settings.branchIssuesShowEmpty);
  const [expanded, setExpanded] = useLocalStorage(
    `branch-issues-expanded:${environmentId}`,
    true,
    Schema.Boolean,
  );
  const [unlinkedExpanded, setUnlinkedExpanded] = useLocalStorage(
    `branch-issues-unlinked-expanded:${environmentId}`,
    true,
    Schema.Boolean,
  );
  const query = Atom.make((get) =>
    [...new Set(cwds)].map((cwd) => {
      const statusAtom = vcsEnvironment.status({ environmentId, input: { cwd } });
      const status = get(statusAtom);
      const data = AsyncResult.getOrElse(status, () => null);
      const provider = data?.sourceControlProvider?.kind;
      const branch = data?.refName;
      const issueAtom =
        branch && (provider === "github" || provider === "meituan")
          ? sourceControlEnvironment.branchIssues({ environmentId, input: { cwd, branch } })
          : null;
      const issues = issueAtom ? get(issueAtom) : null;
      const result = issues ? AsyncResult.getOrElse(issues, () => null) : null;
      return {
        cwd,
        statusAtom,
        issueAtom,
        pending: (!data && status.waiting) || !!issues?.waiting,
        failed: status._tag === "Failure" || issues?._tag === "Failure",
        target: branch && provider && result ? { environmentId, cwd, branch, ...result } : null,
      };
    }),
  );
  const entries = useAtomValue(query);
  const { groups, unlinked } = groupBranchIssues(
    entries.flatMap((entry) => (entry.target ? [entry.target] : [])),
    currentCwd,
  );
  const pending = entries.some((entry) => entry.pending);
  const failed = entries.some((entry) => entry.failed);
  function refresh() {
    for (const entry of entries) {
      registry.refresh(entry.statusAtom);
      if (entry.issueAtom) registry.refresh(entry.issueAtom);
    }
  }
  if (!creationControl && !groups.length && !pending && !failed && (!showEmpty || !unlinked.length))
    return null;
  return (
    <section
      aria-label={t("Linked issues")}
      data-branch-issues-panel
      className="dropdown-glass shrink-0 overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-2 py-2 pr-2 pl-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Link2Icon className="size-4 text-muted-foreground" />
          {t("Linked issues")}
          <span className="text-muted-foreground">
            {
              new Set([
                ...groups.map((group) => group.issue.url),
                ...threadIssues.map((item) => item.issue!.url),
              ]).size
            }
          </span>
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("Refresh issues")}
                disabled={pending}
                onClick={refresh}
              />
            }
          >
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipPopup>{t("Refresh issues")}</TooltipPopup>
        </Tooltip>
        <ThreadDetailsControl
          part="secondary"
          aria-label={t(expanded ? "Collapse linked issues" : "Expand linked issues")}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDownIcon className={expanded ? "size-4 rotate-180" : "size-4"} />
        </ThreadDetailsControl>
      </div>
      <div hidden={!expanded} className="space-y-3 px-3 pb-3">
        {creationControl}
        {threadIssues
          .filter((item) => !groups.some((group) => group.issue.url === item.issue?.url))
          .map((item) => (
            <Link
              key={item.id}
              className="block text-xs text-primary hover:underline"
              to="/requirements"
              search={{
                environmentId,
                provider: item.issue!.provider,
                issueId: item.issue!.id,
                issueProjectId: item.projectId,
                issueScope: item.issue!.repository,
              }}
            >
              {item.title} #{item.issue!.id}
            </Link>
          ))}
        {pending ? <p className="text-xs text-muted-foreground">{t("Loading...")}</p> : null}
        {failed ? (
          <div role="alert" className="text-xs text-destructive">
            {t("Could not load linked issues.")}
            <Button variant="ghost" size="xs" onClick={refresh}>
              {t("Retry")}
            </Button>
          </div>
        ) : null}
        {groups.map((group) => (
          <IssueCard key={group.issue.url} {...group} currentCwd={currentCwd} refresh={refresh} />
        ))}
        {unlinked.length && showEmpty ? (
          <section aria-label={t("Unlinked branches")}>
            <div className="-mr-1 flex min-h-8 items-center gap-2 pl-1">
              <button
                type="button"
                className="min-w-0 flex-1 text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring"
                aria-expanded={unlinkedExpanded}
                onClick={() => setUnlinkedExpanded(!unlinkedExpanded)}
              >
                {t("Unlinked branches")}{" "}
                <span className="text-muted-foreground">{unlinked.length}</span>
              </button>
              <ThreadDetailsControl
                part="secondary"
                aria-label={t(
                  unlinkedExpanded ? "Collapse unlinked branches" : "Expand unlinked branches",
                )}
                aria-expanded={unlinkedExpanded}
                onClick={() => setUnlinkedExpanded(!unlinkedExpanded)}
              >
                <ChevronDownIcon className={unlinkedExpanded ? "size-4 rotate-180" : "size-4"} />
              </ThreadDetailsControl>
            </div>
            <div hidden={!unlinkedExpanded}>
              {unlinked.map((target) => (
                <BranchRow
                  key={JSON.stringify([target.cwd, target.branch])}
                  target={target}
                  current={target.cwd === currentCwd}
                  refresh={refresh}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}
