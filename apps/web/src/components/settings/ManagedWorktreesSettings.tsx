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
import { useEffect, useState, type ReactNode } from "react";
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
import { SettingsSection } from "./settingsLayout";
import { Badge } from "../ui/badge";
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
  const restorable = canRestoreManagedWorktree(group);
  const needsAttention = managedWorktreeSection(group) === "Needs attention";
  const resource = group.resources.length === 1 ? group.resources[0] : undefined;
  const branchLabel = (entry: ManagedWorktreeGroup["resources"][number]) =>
    entry.branch ?? t(entry.branchSource === "git" ? "Detached HEAD" : "Unknown branch");
  return (
    <div className="space-y-1 border-t border-border/50 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {cleanable ? (
            <label className="flex min-h-7 min-w-0 items-center gap-2 pointer-coarse:min-h-11">
              <Checkbox checked={selected} disabled={!allowed || busy} onCheckedChange={onSelect} />
              <span className="wrap-anywhere text-sm font-medium">{group.title}</span>
            </label>
          ) : (
            <span className="wrap-anywhere text-sm font-medium">{group.title}</span>
          )}
          <Badge
            variant={group.status === "failed" ? "error" : needsAttention ? "warning" : "secondary"}
          >
            {t(
              group.status === "removed" && !group.recoveryPending
                ? "Working directory missing"
                : needsAttention && group.status !== "failed"
                  ? "Needs attention"
                  : statusLabels[group.status],
            )}
          </Badge>
        </div>
        {needsAttention || restorable || cleanable ? (
          <div className="flex flex-wrap items-center gap-2 @max-sm:ml-auto">
            {needsAttention ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={t("Retry inspection")}
                onClick={onRetry}
              >
                <RefreshCwIcon />
                {t("Retry")}
              </Button>
            ) : null}
            {restorable ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!restoreAllowed || busy}
                aria-label={t("Rebuild worktrees")}
                onClick={onRestore}
              >
                <RotateCcwIcon />
                {t("Rebuild")}
              </Button>
            ) : cleanable ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!allowed || busy}
                aria-label={t("Clean worktrees")}
                onClick={onRemove}
              >
                {t("Clean")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {resource ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 wrap-anywhere text-xs text-muted-foreground">
          <span className="font-mono">
            {branchLabel(resource)}
            {resource.branchSource === "history" ? ` · ${t("Historical branch")}` : null}
          </span>
          <span className="min-w-0 truncate font-mono">
            …/{resource.path.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}
          </span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("{count} worktrees", { count: group.resources.length })}
        </p>
      )}
      {group.reason ? (
        <p className="wrap-anywhere text-xs text-muted-foreground">{t(group.reason)}</p>
      ) : null}
      {(cleanable && !allowed) || (restorable && !restoreAllowed) ? (
        <p className="text-xs text-muted-foreground">
          {t("This connection cannot manage worktrees.")}
        </p>
      ) : null}
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-7 items-center gap-1 text-xs text-muted-foreground pointer-coarse:min-h-11">
          <ChevronRightIcon className="size-3 group-data-panel-open:rotate-90" />
          {t("Details")} · {t("{count} linked threads", { count: group.threads.length })}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-3 rounded-lg bg-muted/40 p-3 text-xs">
            <ul className="space-y-2">
              {group.resources.map((entry) => (
                <li key={entry.path} className="space-y-1 wrap-anywhere">
                  {group.resources.length > 1 ? (
                    <p>
                      {entry.name} · {branchLabel(entry)}
                      {entry.branchSource === "history" ? ` · ${t("Historical branch")}` : null}
                      {!entry.present ? ` · ${t("Working directory missing")}` : null}
                    </p>
                  ) : null}
                  <p className="text-muted-foreground">{t("Full path")}</p>
                  <p className="select-text font-mono">{entry.path}</p>
                </li>
              ))}
            </ul>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void copyToClipboard(group.resources.map((entry) => entry.path).join("\n"))
              }
            >
              <CopyIcon />
              {t(isCopied ? "Copied" : "Copy path")}
            </Button>
            <ul className="space-y-1">
              {group.threads.map((thread) => (
                <li key={thread.id}>
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: thread.id }}
                    className="inline-flex min-h-7 items-center wrap-anywhere text-primary hover:underline pointer-coarse:min-h-11"
                  >
                    {thread.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function WorktreeSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const t = useUiTranslation();
  return title === "Missing working directories" ? (
    <Collapsible>
      <CollapsibleTrigger className="group flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
        <ChevronRightIcon className="size-3 group-data-panel-open:rotate-90" />
        {t(title)} ({count})
      </CollapsibleTrigger>
      <CollapsiblePanel>{children}</CollapsiblePanel>
    </Collapsible>
  ) : (
    <div className="pt-2">
      <h4 className="py-2 text-xs font-medium text-muted-foreground">
        {t(title)} ({count})
      </h4>
      {children}
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
  const currentCount = rows.reduce(
    (total, group) =>
      total +
      group.resources.filter(
        (resource) =>
          resource.inspection === "linked" ||
          (resource.inspection === undefined && resource.present),
      ).length,
    0,
  );
  const attentionCount = rows.filter(
    (group) => managedWorktreeSection(group) === "Needs attention",
  ).length;
  const historyCount = rows.filter(
    (group) => managedWorktreeSection(group) === "Missing working directories",
  ).length;
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
    <div className="@container px-3 py-3 sm:px-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 pb-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{label}</h3>
          {query.data ? (
            <p className="text-xs text-muted-foreground">
              {t("Worktrees: {current} · Needs attention: {attention} · History: {history}", {
                current: currentCount,
                attention: attentionCount,
                history: historyCount,
              })}
            </p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || query.isPending}
          onClick={query.refresh}
        >
          <RefreshCwIcon />
          {t("Refresh")}
        </Button>
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
          <CollapsibleTrigger className="group flex min-h-11 w-full flex-wrap items-center justify-between gap-2 border-y border-border/50 py-2 text-left text-xs text-muted-foreground">
            <span className="min-w-0 wrap-anywhere">
              {report.data ? (
                <>
                  {t(report.data.trigger === "automatic" ? "Automatic cleanup" : "Manual cleanup")}{" "}
                  · {new Date(report.data.finishedAt).toLocaleString()} ·{" "}
                  {t("{count} items removed", { count: cleanupCounts.removed })}
                </>
              ) : (
                t("Recent cleanup results")
              )}
            </span>
            <span className="flex items-center gap-1">
              {t("View results")}
              <ChevronRightIcon className="size-3 group-data-panel-open:rotate-90" />
            </span>
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
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-3">
              <CollapsibleTrigger className="group flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium pointer-coarse:min-h-11">
                <ChevronRightIcon className="size-3.5 shrink-0 group-data-panel-open:rotate-90" />
                <span className="min-w-0 wrap-anywhere">{title}</span>
              </CollapsibleTrigger>
              {eligible.length > 0 ? (
                <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground pointer-coarse:min-h-11">
                  <Checkbox
                    checked={checked}
                    indeterminate={!checked && eligible.some((group) => selected.has(group.id))}
                    disabled={!allowed || busy || query.isPending}
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
                  <span className="sr-only">{title}: </span>
                  {t("Select cleanable ({count})", { count: eligible.length })}
                </label>
              ) : (
                <span className="text-xs text-muted-foreground">{t("No cleanable worktrees")}</span>
              )}
            </div>
            <CollapsiblePanel>
              {(
                ["Needs attention", "Current worktrees", "Missing working directories"] as const
              ).map((section) => {
                const entries = members.filter(
                  (group) => managedWorktreeSection(group) === section,
                );
                if (entries.length === 0) return null;
                return (
                  <WorktreeSection key={section} title={section} count={entries.length}>
                    {entries.map((group) => (
                      <WorktreeRow
                        key={group.id}
                        group={group}
                        environmentId={environmentId}
                        selected={selected.has(group.id)}
                        allowed={allowed}
                        restoreAllowed={restoreAllowed}
                        busy={busy || query.isPending}
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
                  </WorktreeSection>
                );
              })}
            </CollapsiblePanel>
          </Collapsible>
        );
      })}
      {selection.length > 0 ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-card py-3">
          <p role="status" className="text-xs">
            {t("Selected groups: {groups} · Worktrees: {count}", {
              groups: selection.length,
              count: selection.reduce((total, group) => total + group.resources.length, 0),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              {t("Clear selection")}
            </Button>
            <Button
              size="sm"
              disabled={!allowed || busy || query.isPending}
              onClick={() => confirm(selection)}
            >
              <Trash2Icon />
              {t("Clean selected ({count})", { count: selection.length })}
            </Button>
          </div>
        </div>
      ) : null}
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
    <SettingsSection id="local-worktrees" title="Local worktrees">
      <p className="px-4 py-3 text-xs text-muted-foreground">
        {t(
          "Manage working directories linked to threads. Branches and thread history are kept when you clean a directory here.",
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
    </SettingsSection>
  );
}
