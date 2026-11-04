import { useAtomValue } from "@effect/atom-react";
import {
  branchIssuePlaceholder,
  parseBranchIssueUrl,
  type BranchIssue,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  Link2Icon,
  PlusIcon,
  RefreshCwIcon,
  UnlinkIcon,
} from "lucide-react";
import { useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useClientSettings } from "../../hooks/useSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

type Target = { environmentId: EnvironmentId; cwd: string; branch: string };

function IssueBody({ target, issue }: { target: Target; issue: BranchIssue }) {
  const t = useUiTranslation();
  const detail = useEnvironmentQuery(
    sourceControlEnvironment.branchIssueDetail({
      environmentId: target.environmentId,
      input: { cwd: target.cwd, branch: target.branch, url: issue.url },
    }),
  );
  if (detail.error)
    return (
      <div role="alert" className="text-xs text-destructive">
        {t("Could not load issue details.")}{" "}
        <Button variant="ghost" size="xs" onClick={detail.refresh}>
          {t("Retry")}
        </Button>
      </div>
    );
  if (!detail.data) return <p className="text-xs text-muted-foreground">{t("Loading...")}</p>;
  return (
    <div className="max-h-80 overflow-auto text-xs wrap-anywhere">
      {detail.data.body ? (
        <ChatMarkdown
          className="text-xs leading-5 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2"
          text={detail.data.body}
          cwd={undefined}
          environmentId={target.environmentId}
        />
      ) : (
        <p className="text-muted-foreground">{t("No description.")}</p>
      )}
    </div>
  );
}

function IssueRow({
  target,
  issue,
  allowed,
  busy,
  remove,
}: {
  target: Target;
  issue: BranchIssue;
  allowed: boolean;
  busy: boolean;
  remove: () => void;
}) {
  const t = useUiTranslation();
  const defaultExpanded = useClientSettings((settings) => settings.branchIssuesExpanded);
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="border-t border-border/50">
      <div className="flex items-start gap-1 pr-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 px-4 py-3 text-left hover:bg-accent/40"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span className="mb-1 block text-xs font-medium leading-5 wrap-anywhere">
              {issue.title}
            </span>
            <span className="mb-1 flex flex-wrap gap-x-2 text-2xs text-muted-foreground">
              <span>
                {issue.provider === "meituan" ? "MEP ONES" : issue.repository} #{issue.id}
              </span>
              <span>{issue.state}</span>
            </span>
          </span>
        </button>
        <div className="shrink-0 pt-3">
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
      </div>
      {expanded ? (
        <div className="space-y-2 px-4 pb-3 pl-9">
          <IssueBody target={target} issue={issue} />
          <div className="flex items-center justify-end gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("Unlink issue")}
                    disabled={!allowed || busy}
                    onClick={remove}
                  />
                }
              >
                <UnlinkIcon />
              </TooltipTrigger>
              <TooltipPopup>{t("Unlink issue")}</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IssueList({
  target,
  provider,
  separate,
}: {
  target: Target;
  provider: string;
  separate: boolean;
}) {
  const t = useUiTranslation();
  const showEmpty = useClientSettings((settings) => settings.branchIssuesShowEmpty);
  const allowed = useAtomValue(
    sourceControlEnvironment.updateBranchIssues.permissionAtom(target.environmentId),
  );
  const update = useAtomCommand(sourceControlEnvironment.updateBranchIssues);
  const query = useEnvironmentQuery(
    sourceControlEnvironment.branchIssues({
      environmentId: target.environmentId,
      input: { cwd: target.cwd, branch: target.branch },
    }),
  );
  const [adding, setAdding] = useState(false);
  const [links, setLinks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(4);
  const issues = query.data?.issues ?? [];
  const unpublished = query.data?.published === false;
  async function mutate(urls: string[], action: "associate" | "disassociate") {
    if (!urls.length || urls.some((url) => parseBranchIssueUrl(url)?.provider !== provider)) {
      setError(t("Enter valid issue links for this repository's hosting platform."));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: target.environmentId,
      input: { cwd: target.cwd, branch: target.branch, urls, action },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Success") {
      setLinks("");
      setAdding(false);
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
  if (query.data && issues.length === 0 && !showEmpty && !adding) return null;
  return (
    <section
      aria-label={t("Linked issues")}
      data-branch-issues-panel
      className={
        separate
          ? "dropdown-glass shrink-0 overflow-hidden rounded-2xl"
          : "border-t border-border/50"
      }
    >
      <div className="flex items-center gap-2 px-4 py-2">
        <Link2Icon className="size-4 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 text-xs font-medium">
          {t("Linked issues")} <span className="text-muted-foreground">{issues.length}</span>
        </h3>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("Refresh issues")}
                disabled={query.isPending || busy}
                onClick={query.refresh}
              />
            }
          >
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipPopup>{t("Refresh issues")}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("Link issues")}
                disabled={!allowed || busy || !query.data || unpublished || issues.length > 0}
                onClick={() => setAdding(!adding)}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup>
            {t(
              unpublished
                ? "Push this branch before linking an issue."
                : issues.length > 0
                  ? "Each branch can link one issue. Unlink the existing issue first."
                  : "Link issues",
            )}
          </TooltipPopup>
        </Tooltip>
      </div>
      {unpublished ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {t("Push this branch before linking an issue.")}
        </p>
      ) : null}
      {query.error ? (
        <div role="alert" className="px-4 pb-3 text-xs text-destructive">
          {t("Could not load linked issues.")}{" "}
          <Button variant="ghost" size="xs" onClick={query.refresh}>
            {t("Retry")}
          </Button>
        </div>
      ) : null}
      {!query.data && !query.error ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">{t("Loading...")}</p>
      ) : null}
      {query.data && !unpublished && issues.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {t("No issues linked to this branch.")}
        </p>
      ) : null}
      {issues.slice(0, limit).map((issue) => (
        <IssueRow
          key={issue.url}
          target={target}
          issue={issue}
          allowed={allowed}
          busy={busy}
          remove={() => void mutate([issue.url], "disassociate")}
        />
      ))}
      {issues.length > limit ? (
        <div className="px-4 py-2">
          <Button variant="ghost" size="xs" onClick={() => setLimit(limit + 10)}>
            {t("Show more")}
          </Button>
        </div>
      ) : null}
      {adding && !unpublished && issues.length === 0 ? (
        <form
          className="space-y-2 border-t border-border/50 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              links
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean),
              "associate",
            );
          }}
        >
          <Input
            size="sm"
            aria-label={t("Issue links")}
            placeholder={t(branchIssuePlaceholder(provider))}
            value={links}
            onChange={(event) => setLinks(event.target.value)}
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
            <Button size="xs" disabled={busy || !allowed || !links.trim()} type="submit">
              <Link2Icon />
              {t(busy ? "Linking..." : "Link issues")}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function BranchIssuesPanel({
  environmentId,
  cwd,
  separate = false,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  separate?: boolean;
}) {
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const provider = status.data?.sourceControlProvider?.kind;
  const branch = status.data?.refName;
  if (!branch || (provider !== "github" && provider !== "meituan")) return null;
  return (
    <IssueList
      key={`${environmentId}:${cwd}:${branch}`}
      target={{ environmentId, cwd, branch }}
      provider={provider}
      separate={separate}
    />
  );
}
