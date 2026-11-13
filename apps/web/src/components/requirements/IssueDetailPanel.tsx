import { useAtomValue } from "@effect/atom-react";
import { BranchIssueError, type EnvironmentId, type IssueTarget } from "@t3tools/contracts";
import { ArrowUpRightIcon, GitBranchIcon, LinkIcon, UnlinkIcon, XIcon } from "lucide-react";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ChatMarkdown from "../ChatMarkdown";
import { IssueSelect } from "./IssueSelect";
import { serverEnvironment } from "../../state/server";
import { RequirementDeliveryPanel } from "./RequirementDeliveryPanel";

const isBranchIssueError = Schema.is(BranchIssueError);

export function IssueDetailPanel({
  environmentId,
  target,
  id,
  cwd,
  close,
  changed,
}: {
  environmentId: EnvironmentId;
  target: IssueTarget;
  id: string;
  cwd: string;
  close: () => void;
  changed: () => void;
}) {
  const t = useUiTranslation();
  const query = useEnvironmentQuery(
    sourceControlEnvironment.issueDetail({ environmentId, input: { ...target, id } }),
  );
  const detail = query.data;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const deliveryQuery = useEnvironmentQuery(
    detail && config?.workItemDelivery === true
      ? serverEnvironment.workItemsLive({ environmentId, input: { issueUrl: detail.url } })
      : null,
  );
  const branches = useEnvironmentQuery(
    detail
      ? sourceControlEnvironment.issueBranches({ environmentId, input: { cwd, url: detail.url } })
      : null,
  );
  const branchError =
    isBranchIssueError(branches.failure) && branches.failure.reason === "invalid-link"
      ? t("Branch links require a repository on the same platform as the issue.")
      : branches.error;
  const allowed = useAtomValue(
    sourceControlEnvironment.setIssueState.permissionAtom(environmentId),
  );
  const canLink = useAtomValue(
    sourceControlEnvironment.updateBranchIssues.permissionAtom(environmentId),
  );
  const setState = useAtomCommand(sourceControlEnvironment.setIssueState);
  const updateBranches = useAtomCommand(sourceControlEnvironment.updateBranchIssues);
  const [nextState, setNextState] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const update = async () => {
    if (!nextState) return;
    setBusy(true);
    const result = await setState({ environmentId, input: { ...target, id, state: nextState } });
    setBusy(false);
    query.refresh();
    if (result._tag === "Success") {
      setNextState("");
      changed();
    }
  };
  const associate = async (name: string, action: "associate" | "disassociate") => {
    if (!detail || !name) return;
    setBusy(true);
    await updateBranches({
      environmentId,
      input: { cwd, branch: name, urls: [detail.url], action },
    });
    setBusy(false);
    branches.refresh();
  };
  return (
    <aside
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      className="flex h-full min-h-0 flex-col border-l border-border bg-background max-md:absolute max-md:inset-0 max-md:z-20 md:w-96 md:shrink-0"
      aria-label={t("Issue details")}
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
        <span className="text-xs text-muted-foreground">
          {target.provider === "meituan" ? "MEP ONES" : "GitHub Issues"} · #{id}
        </span>
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
          <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
        ) : (
          <>
            <h2 className="text-lg font-semibold wrap-anywhere">{detail.title}</h2>
            {deliveryQuery.data?.item ? (
              <RequirementDeliveryPanel
                environmentId={environmentId}
                item={deliveryQuery.data.item}
                summary={deliveryQuery.data.items[0]?.deliverySummary}
                transitions={detail.transitions}
              />
            ) : null}
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
            <div className="border-t border-border pt-4 text-sm wrap-anywhere">
              {detail.body ? (
                <ChatMarkdown text={detail.body} cwd={cwd} environmentId={environmentId} />
              ) : (
                <p className="text-muted-foreground">{t("No description.")}</p>
              )}
            </div>
            <section className="space-y-3 border-t border-border pt-4">
              <h3 className="text-sm font-medium">{t("Linked branches")}</h3>
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
            </section>
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
