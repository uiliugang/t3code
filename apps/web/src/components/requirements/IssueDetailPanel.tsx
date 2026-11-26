import { useAtomValue } from "@effect/atom-react";
import { issueReferenceCompatible, issueReferenceHost } from "@t3tools/client-runtime/issue-links";
import {
  BranchIssueError,
  IssueTrackerKind,
  type IssueOption,
  isMeituanServiceEnabled,
  type EnvironmentId,
  type IssueTarget,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, GitBranchIcon, LinkIcon, UnlinkIcon, XIcon } from "lucide-react";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ChatMarkdown from "../ChatMarkdown";
import { IssueSelect } from "./IssueSelect";
import { serverEnvironment } from "../../state/server";
import { refreshIssueLists } from "../../state/issues";
import { RequirementDeliveryPanel } from "./RequirementDeliveryPanel";
import { ProjectTag } from "./ProjectTag";

import {
  IssueDetailPanel as TrackerDetailPanel,
  IssueLinkUnavailable,
} from "../issue/IssueDetailPanel";
import { PullRequestSection } from "../pullRequest/PullRequestSummaryTab";
import type { RequirementTracker } from "@t3tools/client-runtime/work-item";
import { REQUIREMENTS_PANEL_REF, useRightPanelStore } from "../../rightPanelStore";

const isBranchIssueError = Schema.is(BranchIssueError);

type PanelProps = {
  environmentId: EnvironmentId;
  target: IssueTarget;
  id: string;
  cwd: string;
  projectTitle: string;
  close?: () => void;
  changed?: () => void;
  embedded?: boolean;
  panelRef?: ScopedThreadRef | undefined;
  onPullRequestOpened?: () => void;
};
export function IssueDetailPanel(
  props: Omit<PanelProps, "target"> & {
    target: Omit<IssueTarget, "provider"> & {
      provider: RequirementTracker;
      url?: string | undefined;
    };
  },
) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const { provider, scope, url, host: rawHost, ...rest } = props.target;
  if (
    !issueReferenceCompatible(
      { tracker: provider, host: rawHost, url },
      config?.environment.capabilities,
    )
  )
    return <IssueLinkUnavailable url={url} />;
  const host = issueReferenceHost(provider, rawHost, url);
  const target = { ...rest, ...(host === undefined ? {} : { host }) };
  const legacy =
    provider === "github" || provider === "meituan"
      ? ({ ...target, ...(scope ? { scope } : {}), provider } satisfies IssueTarget)
      : null;
  if (scope && (config?.requirementIssueTrackers || !legacy))
    return (
      <TrackerDetailPanel
        environmentId={props.environmentId}
        reference={{
          ...target,
          scope,
          key: props.id,
          tracker: IssueTrackerKind.make(provider),
          ...(url ? { url } : {}),
        }}
        threadRef={
          props.panelRef?.threadId === REQUIREMENTS_PANEL_REF.threadId
            ? null
            : (props.panelRef ?? null)
        }
        onIssueChanged={props.changed}
        onSelectPullRequest={(reference) => {
          useRightPanelStore.getState().openPullRequest(props.panelRef ?? REQUIREMENTS_PANEL_REF, {
            projectId: reference.projectId,
            repository: reference.repository,
            number: reference.number,
            ...(reference.host ? { host: reference.host } : {}),
            environmentId: props.environmentId,
          });
          props.onPullRequestOpened?.();
        }}
        onSelectIssue={({ host, ...reference }) => {
          useRightPanelStore.getState().openIssue(props.panelRef ?? REQUIREMENTS_PANEL_REF, {
            ...reference,
            ...(host === undefined ? {} : { host }),
            environmentId: props.environmentId,
          });
          props.onPullRequestOpened?.();
        }}
        renderSupplement={
          legacy
            ? (detail) => (
                <RequirementExtras
                  environmentId={props.environmentId}
                  target={legacy}
                  id={props.id}
                  cwd={props.cwd}
                  panelRef={props.panelRef}
                  url={detail.url}
                />
              )
            : undefined
        }
      />
    );
  return legacy ? <LegacyIssueDetailPanel {...props} target={legacy} /> : null;
}
function LegacyIssueDetailPanel({
  environmentId,
  target,
  id,
  cwd,
  projectTitle,
  close,
  changed,
  embedded = false,
  panelRef,
}: PanelProps) {
  const t = useUiTranslation();
  const settings = useEnvironmentSettings(environmentId, (settings) => settings);
  const enabled =
    target.provider !== "meituan" || isMeituanServiceEnabled(settings, "requirements");
  const query = useEnvironmentQuery(
    enabled
      ? sourceControlEnvironment.issueDetail({ environmentId, input: { ...target, id } })
      : null,
  );
  const detail = query.data;
  const allowed = useAtomValue(
    sourceControlEnvironment.setIssueState.permissionAtom(environmentId),
  );
  const setState = useAtomCommand(sourceControlEnvironment.setIssueState);
  const [nextState, setNextState] = useState("");
  const [busy, setBusy] = useState(false);
  const update = async () => {
    if (!nextState) return;
    setBusy(true);
    const result = await setState({ environmentId, input: { ...target, id, state: nextState } });
    setBusy(false);
    query.refresh();
    if (result._tag === "Success") {
      setNextState("");
      refreshIssueLists(environmentId);
      changed?.();
    }
  };
  return (
    <aside
      onKeyDown={(event) => {
        if (event.key === "Escape") close?.();
      }}
      className={
        embedded
          ? "flex h-full min-h-0 flex-1 flex-col bg-background"
          : "flex h-full min-h-0 flex-col border-l border-border/60 bg-background max-md:absolute max-md:inset-0 max-md:z-20 md:w-[min(42%,440px)] md:min-w-80 md:shrink-0"
      }
      aria-label={t("Issue details")}
    >
      <div
        className={`flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 ${embedded ? "h-10" : "h-14"}`}
      >
        <span className="text-xs text-muted-foreground">
          {target.provider === "meituan" ? t("MEP ONES") : t("GitHub Issues")} · #{id}
        </span>
        {!embedded && close ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("Close details")}
                  autoFocus
                  onClick={close}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup>{t("Close details")}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        {query.error ? (
          <p role="alert" className="text-sm text-destructive">
            {query.error}
            <Button size="xs" variant="ghost" onClick={query.refresh}>
              {t("Retry")}
            </Button>
          </p>
        ) : !detail ? (
          <p className="text-sm text-muted-foreground">
            {t(enabled ? "Loading..." : "This service is disabled. Saved settings are retained.")}
          </p>
        ) : (
          <>
            <div className="space-y-3">
              <ProjectTag title={projectTitle} />
              <h2 className="text-lg font-semibold wrap-anywhere">{detail.title}</h2>
              <p className="text-xs text-muted-foreground">
                {detail.state} ·{" "}
                {detail.assignees.map((person) => person.label).join(", ") || t("Unassigned")}
              </p>
            </div>
            <RequirementExtras
              environmentId={environmentId}
              target={target}
              id={id}
              cwd={cwd}
              panelRef={panelRef}
              url={detail.url}
              transitions={detail.transitions}
            />
            <details className="border-t border-border/60 pt-3">
              <summary className="cursor-pointer text-xs font-medium">{t("Issue details")}</summary>
              <div className="mt-3 space-y-3">
                <dl className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 text-sm">
                  <dt className="text-muted-foreground">{t("Status")}</dt>
                  <dd>{detail.state}</dd>
                  <dt className="text-muted-foreground">{t("Assignee")}</dt>
                  <dd>
                    {detail.assignees.map((person) => person.label).join(", ") || t("Unassigned")}
                  </dd>
                </dl>
                {detail.transitions.length ? (
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <IssueSelect
                        label={t("Change status")}
                        value={nextState}
                        options={[
                          { value: "", label: t("Change status") },
                          ...detail.transitions.map((option) => ({
                            ...option,
                            label: t(option.label),
                          })),
                        ]}
                        onChange={setNextState}
                        disabled={!allowed || busy}
                      />
                    </div>
                    <Button
                      size="sm"
                      disabled={!allowed || busy || !nextState}
                      onClick={() => void update()}
                    >
                      {t("Update")}
                    </Button>
                  </div>
                ) : null}
              </div>
            </details>
            <details className="border-t border-border/60 pt-3">
              <summary className="cursor-pointer text-xs font-medium">{t("Description")}</summary>
              <div className="pt-3 text-sm wrap-anywhere">
                {detail.body ? (
                  <ChatMarkdown text={detail.body} cwd={cwd} environmentId={environmentId} />
                ) : (
                  <p className="text-muted-foreground">{t("No description.")}</p>
                )}
              </div>
            </details>

            <div>
              <Button
                variant="outline"
                size="sm"
                render={<a href={detail.url} target="_blank" rel="noreferrer" />}
              >
                <ArrowUpRightIcon />
                {t("View original")}
              </Button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function RequirementExtras({
  environmentId,
  target,
  id,
  cwd,
  panelRef,
  url,
  transitions,
}: Pick<PanelProps, "environmentId" | "target" | "id" | "cwd" | "panelRef"> & {
  url: string;
  transitions?: ReadonlyArray<IssueOption>;
}) {
  const t = useUiTranslation();
  const settings = useEnvironmentSettings(environmentId, (settings) => settings);
  const enabled =
    target.provider !== "meituan" || isMeituanServiceEnabled(settings, "requirements");
  const branchesEnabled =
    enabled &&
    (target.provider !== "meituan" || isMeituanServiceEnabled(settings, "sourceControl"));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const deliveryQuery = useEnvironmentQuery(
    config?.workItemDelivery === true
      ? serverEnvironment.workItemsLive({ environmentId, input: { issueUrl: url } })
      : null,
  );
  const branches = useEnvironmentQuery(
    branchesEnabled
      ? sourceControlEnvironment.issueBranches({ environmentId, input: { cwd, url: url } })
      : null,
  );
  const branchError =
    isBranchIssueError(branches.failure) && branches.failure.reason === "invalid-link"
      ? t("Branch links require a repository on the same platform as the issue.")
      : branches.error;
  const linkAllowed = useAtomValue(
    sourceControlEnvironment.updateBranchIssues.permissionAtom(environmentId),
  );
  const canLink = linkAllowed && branchesEnabled;
  const transitionQuery = useEnvironmentQuery(
    !transitions && deliveryQuery.data?.item
      ? sourceControlEnvironment.issueDetail({ environmentId, input: { ...target, id } })
      : null,
  );
  const updateBranches = useAtomCommand(sourceControlEnvironment.updateBranchIssues);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const associate = async (name: string, action: "associate" | "disassociate") => {
    if (!name) return;
    setBusy(true);
    await updateBranches({
      environmentId,
      input: { cwd, branch: name, urls: [url], action },
    });
    setBusy(false);
    branches.refresh();
  };
  return (
    <>
      {deliveryQuery.data?.item ? (
        <div className="px-4 pb-4">
          <RequirementDeliveryPanel
            environmentId={environmentId}
            item={deliveryQuery.data.item}
            summary={deliveryQuery.data.items[0]?.deliverySummary}
            transitions={transitions ?? transitionQuery.data?.transitions ?? []}
            panelRef={panelRef}
          />
        </div>
      ) : null}
      <PullRequestSection title={t("Linked branches")}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t(target.provider === "meituan" ? "Synced with MEP" : "Only in this environment")}
          </p>
          {branches.error ? (
            <p role="alert" className="text-xs text-destructive">
              {branchError}
            </p>
          ) : null}
          {branches.data
            ?.filter((item) => item.linked)
            .map((item) => (
              <div key={item.name} className="flex min-w-0 items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <GitBranchIcon className="size-4 shrink-0" />
                  <span className="truncate font-mono text-xs">{item.name}</span>
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!canLink || busy}
                        onClick={() => void associate(item.name, "disassociate")}
                        aria-label={t("Unlink issue")}
                      />
                    }
                  >
                    <UnlinkIcon />
                  </TooltipTrigger>
                  <TooltipPopup>{t("Unlink issue")}</TooltipPopup>
                </Tooltip>
              </div>
            ))}
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <IssueSelect
                label={t("Choose branch")}
                value={branch}
                options={[
                  { value: "", label: t("Choose branch") },
                  ...(branches.data ?? [])
                    .filter((item) => !item.linked)
                    .map((item) => ({ value: item.name, label: item.name })),
                ]}
                onChange={setBranch}
                disabled={!canLink || busy}
              />
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="outline"
                    disabled={!canLink || busy || !branch}
                    onClick={() => void associate(branch, "associate")}
                    aria-label={t("Link branch")}
                  />
                }
              >
                <LinkIcon />
              </TooltipTrigger>
              <TooltipPopup>{t("Link branch")}</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      </PullRequestSection>
    </>
  );
}
