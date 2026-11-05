import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  branchIssuePlaceholder,
  parseBranchIssueUrl,
  type BranchIssue,
  type EnvironmentId,
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
import { useContext, useState } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { vcsEnvironment } from "../../state/vcs";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { groupBranchIssues, type IssueBranch } from "./branchIssueGroups";

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
  const [adding, setAdding] = useState(false);
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
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-mono text-xs wrap-anywhere">{target.branch}</span>
          {current ? (
            <span className="shrink-0 text-2xs text-success">{t("Current branch")}</span>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={<span className="max-w-24 truncate text-2xs text-muted-foreground" />}
          >
            {target.cwd.split(/[/\\]/).filter(Boolean).at(-1)}
          </TooltipTrigger>
          <TooltipPopup>{target.cwd}</TooltipPopup>
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
                  size={issue ? "icon-xs" : "xs"}
                  disabled={!allowed || busy}
                  aria-label={t(issue ? "Unlink issue" : "Link issues")}
                  onClick={() => (issue ? void mutate() : setAdding(!adding))}
                />
              }
            >
              {issue ? (
                <UnlinkIcon />
              ) : (
                <>
                  <PlusIcon />
                  {t("Link issues")}
                </>
              )}
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
      <div className="px-3 pt-3 pb-2">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
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
        <div className="px-3">
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
}: {
  environmentId: EnvironmentId;
  cwds: readonly string[];
  currentCwd: string | null;
}) {
  const t = useUiTranslation();
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
  if (!groups.length && !pending && !failed && (!showEmpty || !unlinked.length)) return null;
  return (
    <section
      aria-label={t("Linked issues")}
      data-branch-issues-panel
      className="dropdown-glass shrink-0 overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Link2Icon className="size-4 text-muted-foreground" />
          {t("Linked issues")}
          <span className="text-muted-foreground">{groups.length}</span>
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
          part="icon"
          aria-label={t(expanded ? "Collapse linked issues" : "Expand linked issues")}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDownIcon className={expanded ? "size-4 rotate-180" : "size-4"} />
        </ThreadDetailsControl>
      </div>
      <div hidden={!expanded} className="space-y-3 px-3 pb-3">
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
            <ThreadDetailsControl
              aria-expanded={unlinkedExpanded}
              onClick={() => setUnlinkedExpanded(!unlinkedExpanded)}
            >
              <span className="flex-1 text-left">
                {t("Unlinked branches")}{" "}
                <span className="text-muted-foreground">{unlinked.length}</span>
              </span>
              <ChevronDownIcon className={unlinkedExpanded ? "size-4 rotate-180" : "size-4"} />
            </ThreadDetailsControl>
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
