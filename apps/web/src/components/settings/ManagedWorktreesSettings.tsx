import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  canRemoveManagedWorktree,
  canRestoreManagedWorktree,
  managedWorktreeSection,
} from "@t3tools/contracts";
import type {
  EnvironmentId,
  ManagedWorktreeGroup,
  ManagedWorktreeResult,
  ProjectId,
} from "@t3tools/contracts";
import { ChevronRightIcon, RefreshCwIcon, RotateCcwIcon, Trash2Icon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { CleanupResults } from "./StorageSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { useSettingsScope } from "./SettingsScopeContext";

const statusLabels = {
  ready: "Ready to clean",
  blocked: "Retained",
  removed: "Worktree removed",
  partial: "Partially cleaned",
  failed: "Inspection failed",
} as const;

function WorktreeRow({
  group,
  environmentId,
  selected,
  allowed,
  restoreAllowed,
  busy,
  onSelect,
  onRemove,
  onRestore,
  onRetry,
}: {
  group: ManagedWorktreeGroup;
  environmentId: EnvironmentId;
  selected: boolean;
  allowed: boolean;
  restoreAllowed: boolean;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onRemove: () => void;
  onRestore: () => void;
  onRetry: () => void;
}) {
  const t = useUiTranslation();
  const cleanable = canRemoveManagedWorktree(group);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "worktree path" });
  const restorable = group.recoveryPending;
  return (
    <div className="border-t border-border/50 py-3">
      <div className="flex items-start gap-3">
        <div className="pt-1">
          {cleanable ? (
            <Checkbox
              checked={selected}
              disabled={!allowed || !cleanable || busy}
              onCheckedChange={onSelect}
              aria-label={t("Select {title}", { title: group.title })}
            />
          ) : (
            <span className="block size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="break-words text-sm font-medium">{group.title}</span>
            <span className="text-xs text-muted-foreground">
              {t(
                group.status === "removed" && !group.recoveryPending
                  ? "Working directory missing"
                  : statusLabels[group.status],
              )}
            </span>
          </div>
          {group.resources.length === 1 ? (
            <div className="text-xs text-muted-foreground">
              <span>
                {group.resources[0]!.branch ??
                  t(
                    group.resources[0]!.branchSource === "git" ? "Detached HEAD" : "Unknown branch",
                  )}
                {group.resources[0]!.branchSource === "history"
                  ? ` · ${t("Historical branch")}`
                  : null}
              </span>
              <p className="break-all font-mono">{group.resources[0]!.path}</p>
            </div>
          ) : (
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground">
                <ChevronRightIcon className="size-3 group-data-panel-open:rotate-90" />
                {t("{count} worktrees", { count: group.resources.length })}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <ul className="space-y-2 pt-2">
                  {group.resources.map((resource) => (
                    <li key={resource.path} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{resource.name}</span>
                      {" / "}
                      {resource.branch ??
                        t(resource.branchSource === "git" ? "Detached HEAD" : "Unknown branch")}
                      {resource.branchSource === "history" ? ` · ${t("Historical branch")}` : null}
                      {!resource.present ? ` · ${t("Worktree removed")}` : null}
                      <p className="break-all font-mono">{resource.path}</p>
                    </li>
                  ))}
                </ul>
              </CollapsiblePanel>
            </Collapsible>
          )}
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground">
              <ChevronRightIcon className="size-3 group-data-panel-open:rotate-90" />
              {t("{count} linked threads", { count: group.threads.length })}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <ul className="space-y-1 pt-1">
                {group.threads.map((thread) => (
                  <li key={thread.id}>
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: thread.id }}
                      className="break-words text-xs text-primary hover:underline"
                    >
                      {thread.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </CollapsiblePanel>
          </Collapsible>
          {group.reason ? (
            <p className="break-words text-xs text-muted-foreground">{t(group.reason)}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {group.status === "failed" ||
          group.resources.some((resource) => resource.inspection === "non-git") ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Retry inspection")}
              disabled={busy}
              onClick={onRetry}
            >
              <RefreshCwIcon />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t(isCopied ? "Copied" : "Copy path")}
            onClick={() =>
              void copyToClipboard(group.resources.map((resource) => resource.path).join("\n"))
            }
          >
            <CopyIcon />
          </Button>
          {restorable ||
          (group.status !== "removed" &&
            group.resources.some(
              (resource) =>
                resource.inspection === "linked" ||
                (resource.inspection === undefined && resource.present),
            )) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={
                      busy ||
                      (restorable
                        ? !restoreAllowed || !canRestoreManagedWorktree(group)
                        : !allowed || !cleanable)
                    }
                    aria-label={t(restorable ? "Rebuild worktrees" : "Clean worktrees")}
                    onClick={restorable ? onRestore : onRemove}
                  />
                }
              >
                {restorable ? <RotateCcwIcon /> : <Trash2Icon />}
              </TooltipTrigger>
              <TooltipPopup>{t(restorable ? "Rebuild worktrees" : "Clean worktrees")}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EnvironmentWorktrees({
  environmentId,
  label,
  projectIds,
  supportsReports,
}: {
  environmentId: EnvironmentId;
  label: string;
  projectIds?: readonly ProjectId[];
  supportsReports: boolean;
}) {
  const t = useUiTranslation();
  const { groups: projectGroups } = useSettingsScope();
  const query = useEnvironmentQuery(
    serverEnvironment.managedWorktrees({ environmentId, input: projectIds ? { projectIds } : {} }),
  );
  const report = useEnvironmentQuery(
    supportsReports ? serverEnvironment.storageCleanupReport({ environmentId, input: {} }) : null,
  );
  const finishedAt = report.data?.finishedAt;
  const refreshInventory = query.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Completed server cleanup reports invalidate the filesystem inventory.
  useEffect(() => {
    if (finishedAt) refreshInventory();
  }, [finishedAt, refreshInventory]);
  const allowed = useAtomValue(
    serverEnvironment.removeManagedWorktrees.permissionAtom(environmentId),
  );
  const restoreAllowed = useAtomValue(
    serverEnvironment.restoreManagedWorktrees.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(serverEnvironment.removeManagedWorktrees);
  const restore = useAtomCommand(serverEnvironment.restoreManagedWorktrees);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ReadonlyArray<ManagedWorktreeGroup> | null>(
    null,
  );
  const [deleteIgnored, setDeleteIgnored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ReadonlyArray<ManagedWorktreeResult>>([]);
  const rows = query.data ?? [];
  const cleanupEntries = (report.data?.entries ?? []).filter(
    (entry) =>
      (entry.kind === "worktree" || entry.kind === "branch") &&
      (!projectIds ||
        rows.some(
          (row) =>
            row.threads.some((thread) => thread.id === entry.threadId) ||
            row.resources.some(
              (resource) => resource.path === entry.path || resource.branch === entry.path,
            ),
        )),
  );
  const cleanupCounts = { removed: 0, kept: 0, failed: 0 };
  for (const entry of cleanupEntries) cleanupCounts[entry.outcome]++;

  const grouped = new Map<string, { title: string; members: ManagedWorktreeGroup[] }>();
  for (const row of rows) {
    const project = projectGroups.find((entry) =>
      entry.memberProjects.some(
        (member) => member.environmentId === environmentId && member.id === row.projectId,
      ),
    );
    const title = project?.displayName ?? row.projectTitle;
    const key = project?.projectKey ?? row.projectId;
    const members = grouped.get(key)?.members ?? [];
    members.push(row);
    grouped.set(key, { title, members });
  }
  const selection = rows.filter((row) => selected.has(row.id) && canRemoveManagedWorktree(row));
  const confirm = (targets: ReadonlyArray<ManagedWorktreeGroup>) => {
    setDeleteIgnored(false);
    setConfirmation(targets);
  };
  const clean = async () => {
    if (!confirmation) return;
    setBusy(true);
    try {
      const result = await remove({
        environmentId,
        input: {
          targets: confirmation.map(({ id, fingerprint }) => ({ id, fingerprint })),
          deleteIgnoredFiles: deleteIgnored,
        },
      });
      if (result._tag === "Success") {
        setResults(result.value);
        setConfirmation(null);
        setSelected(new Set());
        query.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const rebuild = async (group: ManagedWorktreeGroup) => {
    const thread = group.threads[0];
    if (!thread) return;
    setBusy(true);
    try {
      const result = await restore({ environmentId, input: { threadId: thread.id } });
      if (result._tag === "Success") {
        setResults((current) => current.filter((entry) => entry.id !== group.id));
        query.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const ignored =
    confirmation?.some((group) => group.resources.some((resource) => resource.ignoredFiles)) ??
    false;
  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <div className="flex items-center gap-2">
          {selection.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!allowed || busy || query.isPending}
              onClick={() => confirm(selection)}
            >
              <Trash2Icon />
              {t("Clean selected ({count})", { count: selection.length })}
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy || query.isPending}
                  aria-label={t("Refresh")}
                  onClick={query.refresh}
                />
              }
            >
              <RefreshCwIcon />
            </TooltipTrigger>
            <TooltipPopup>{t("Refresh")}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {query.isPending ? (
        <p role="status" className="py-2 text-xs text-muted-foreground">
          {t("Checking worktrees...")}
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="break-words py-2 text-xs text-destructive">
          {query.error}
        </p>
      ) : null}
      {!query.isPending && !query.error && rows.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{t("No managed worktrees")}</p>
      ) : null}
      {supportsReports ? (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <ChevronRightIcon className="size-3" />
            {t("Recent cleanup results")}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <p className="py-2 text-xs text-muted-foreground">
              {t(
                "Latest results since this server started. Active tasks, terminals and provider sessions delay cleanup.",
              )}
            </p>
            {report.error ? (
              <p className="text-xs text-destructive">
                {t("Could not load recent cleanup results.")}
              </p>
            ) : report.data ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t(report.data.trigger === "automatic" ? "Automatic cleanup" : "Manual cleanup")}{" "}
                  · {new Date(report.data.finishedAt).toLocaleString()}
                </p>
                <p className="py-2 text-xs text-muted-foreground">
                  {t(
                    "Shown results: {removed} removed, {kept} retained, {failed} failed",
                    cleanupCounts,
                  )}
                </p>
                <CleanupResults
                  environmentLabel={label}
                  report={{
                    ...report.data,
                    entries: cleanupEntries,
                  }}
                />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("No cleanup results since this server started.")}
              </p>
            )}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {[...grouped].map(([key, { title, members }]) => {
        const eligible = members.filter((group) => canRemoveManagedWorktree(group));
        const checked = eligible.length > 0 && eligible.every((group) => selected.has(group.id));
        return (
          <Collapsible key={key} defaultOpen>
            <div className="flex items-center gap-3 border-t border-border py-3">
              <Checkbox
                checked={checked}
                indeterminate={!checked && eligible.some((group) => selected.has(group.id))}
                disabled={!allowed || busy || eligible.length === 0}
                aria-label={t("Select {title}", { title })}
                onCheckedChange={(value) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const group of eligible) {
                      if (value) next.add(group.id);
                      else next.delete(group.id);
                    }
                    return next;
                  })
                }
              />
              <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium">
                <ChevronRightIcon className="size-3.5 shrink-0 group-data-panel-open:rotate-90" />
                <span className="min-w-0 flex-1 break-words">{title}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {t("{count} worktrees", {
                    count: members.reduce(
                      (total, group) =>
                        total +
                        group.resources.filter(
                          (resource) =>
                            resource.inspection === "linked" ||
                            (resource.inspection === undefined && resource.present),
                        ).length,
                      0,
                    ),
                  })}
                </span>
              </CollapsibleTrigger>
            </div>
            <CollapsiblePanel>
              {(
                ["Current worktrees", "Needs attention", "Missing working directories"] as const
              ).map((section) => {
                const entries = members.filter(
                  (group) => managedWorktreeSection(group) === section,
                );
                if (entries.length === 0) return null;
                return (
                  <Collapsible
                    key={section}
                    defaultOpen={section !== "Missing working directories"}
                  >
                    <CollapsibleTrigger className="group flex items-center gap-2 py-2 text-xs text-muted-foreground">
                      <ChevronRightIcon className="size-3 group-data-panel-open:rotate-90" />
                      {t(section)} ({entries.length})
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      {entries.map((group) => (
                        <WorktreeRow
                          key={group.id}
                          group={group}
                          environmentId={environmentId}
                          selected={selected.has(group.id)}
                          allowed={allowed && !query.isPending}
                          restoreAllowed={restoreAllowed && !query.isPending}
                          busy={busy}
                          onSelect={(value) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (value) next.add(group.id);
                              else next.delete(group.id);
                              return next;
                            })
                          }
                          onRemove={() => confirm([group])}
                          onRestore={() => void rebuild(group)}
                          onRetry={query.refresh}
                        />
                      ))}
                    </CollapsiblePanel>
                  </Collapsible>
                );
              })}
            </CollapsiblePanel>
          </Collapsible>
        );
      })}
      {results.length > 0 ? (
        <ul aria-live="polite" className="space-y-2 border-t border-border pt-3">
          {results.map((result) => (
            <li key={result.id} className="break-words text-xs">
              <span className="font-medium">
                {rows.find((row) => row.id === result.id)?.title ?? result.id}:{" "}
              </span>
              {t(result.detail)}
            </li>
          ))}
        </ul>
      ) : null}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Clean worktrees")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Branches, commits and thread history are kept. Working directories are deleted. Continue a thread to rebuild its worktrees.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-72 space-y-3 overflow-y-auto px-6 pb-6">
            {confirmation?.map((group) => (
              <div key={group.id} className="text-sm">
                <p className="break-words font-medium">{group.title}</p>
                <p className="text-xs text-muted-foreground">
                  {t("{count} linked threads", { count: group.threads.length })}
                </p>
                {group.resources.map((resource) => (
                  <p
                    key={resource.path}
                    className="break-all font-mono text-xs text-muted-foreground"
                  >
                    {resource.path}
                  </p>
                ))}
              </div>
            ))}
            {ignored ? (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={deleteIgnored} onCheckedChange={setDeleteIgnored} />
                <span>
                  {t(
                    "Also delete ignored files, including .env and installed dependencies. These files cannot be restored.",
                  )}
                </span>
              </label>
            ) : null}
          </div>
          <AlertDialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!allowed || busy || (ignored && !deleteIgnored)}
              onClick={() => void clean()}
            >
              {busy
                ? t("Cleaning...")
                : t("Clean {groups} groups ({count} worktrees)", {
                    groups: confirmation?.length ?? 0,
                    count:
                      confirmation?.reduce((total, group) => total + group.resources.length, 0) ??
                      0,
                  })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export function ManagedWorktreesSettings() {
  const t = useUiTranslation();
  const { connectedEnvironments, scope } = useSettingsScope();
  return (
    <FoldedSettingsSection id="local-worktrees" title={t("Local worktrees")}>
      <p className="px-4 py-3 text-xs text-muted-foreground">
        {t(
          "Worktrees linked to threads in this environment. Missing directories are shown separately; ordinary working folders are excluded.",
        )}
      </p>
      {connectedEnvironments.map((environment) => (
        <EnvironmentWorktrees
          key={`${environment.environmentId}:${scope.kind}:${scope.members.map((member) => member.id).join(",")}`}
          environmentId={environment.environmentId}
          label={environment.label}
          supportsReports={
            environment.serverConfig?.environment.capabilities.storageCleanupRun === true
          }
          {...(scope.kind === "project" || scope.kind === "checkout"
            ? {
                projectIds: scope.members
                  .filter((member) => member.environmentId === environment.environmentId)
                  .map((member) => member.id),
              }
            : {})}
        />
      ))}
      {connectedEnvironments.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">{t("Environment offline")}</p>
      ) : null}
    </FoldedSettingsSection>
  );
}
