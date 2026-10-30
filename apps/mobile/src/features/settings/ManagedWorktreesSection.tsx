import { useAtomValue } from "@effect/atom-react";
import {
  canRemoveManagedWorktree,
  canRestoreManagedWorktree,
  managedWorktreeSection,
} from "@t3tools/contracts";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import type {
  EnvironmentId,
  ManagedWorktreeGroup,
  ManagedWorktreeResult,
  ProjectId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";

function WorktreeList({
  environmentId,
  projectIds,
}: {
  environmentId: EnvironmentId;
  projectIds?: readonly ProjectId[];
}) {
  const t = useUiTranslation();
  const openThread = useOpenLinkedThread();
  const query = useEnvironmentQuery(
    serverEnvironment.managedWorktrees({ environmentId, input: projectIds ? { projectIds } : {} }),
  );
  const supportsReports =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .storageCleanupRun === true;
  const report = useEnvironmentQuery(
    supportsReports ? serverEnvironment.storageCleanupReport({ environmentId, input: {} }) : null,
  );
  const finishedAt = report.data?.finishedAt;
  const refreshInventory = query.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Completed server cleanup reports invalidate the filesystem inventory.
  useEffect(() => {
    if (finishedAt) refreshInventory();
  }, [finishedAt, refreshInventory]);
  const [showHistory, setShowHistory] = useState(false);
  const allowed = useAtomValue(
    serverEnvironment.removeManagedWorktrees.permissionAtom(environmentId),
  );
  const restoreAllowed = useAtomValue(
    serverEnvironment.restoreManagedWorktrees.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(serverEnvironment.removeManagedWorktrees);
  const restore = useAtomCommand(serverEnvironment.restoreManagedWorktrees);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
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

  const selectedRows = rows.filter(
    (group) => selected.has(group.id) && canRemoveManagedWorktree(group),
  );
  const clean = (groups: ReadonlyArray<ManagedWorktreeGroup>) => {
    const ignored = groups.some((group) =>
      group.resources.some((resource) => resource.ignoredFiles),
    );
    Dialog.confirm({
      title: t("Clean {groups} groups ({count} worktrees)", {
        groups: groups.length,
        count: groups.reduce((total, group) => total + group.resources.length, 0),
      }),
      message: [
        groups.map((group) => `${group.title} (${group.threads.length})`).join("\n"),
        t(
          "Branches, commits and thread history are kept. Working directories are deleted. Continue a thread to rebuild its worktrees.",
        ),
        ...(ignored
          ? [
              t(
                "Also delete ignored files, including .env and installed dependencies. These files cannot be restored.",
              ),
            ]
          : []),
      ].join("\n\n"),
      confirmText: t("Clean worktrees"),
      cancelText: t("Cancel"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusy(true);
          try {
            const result = await remove({
              environmentId,
              input: {
                targets: groups.map(({ id, fingerprint }) => ({ id, fingerprint })),
                deleteIgnoredFiles: ignored,
              },
            });
            if (result._tag === "Success") {
              setResults(result.value);
              setSelected(new Set());
              query.refresh();
            }
          } finally {
            setBusy(false);
          }
        })();
      },
    });
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
  return (
    <View className="gap-2 p-3">
      <Button
        label={t("Refresh")}
        icon="arrow.clockwise"
        tone="text"
        disabled={busy || query.isPending}
        onPress={query.refresh}
      />
      {query.isPending ? (
        <Text className="text-sm text-foreground-muted">{t("Checking worktrees...")}</Text>
      ) : null}
      {query.error ? <Text className="text-sm text-danger-foreground">{query.error}</Text> : null}
      {!query.isPending && !query.error && rows.length === 0 ? (
        <Text className="text-sm text-foreground-muted">{t("No managed worktrees")}</Text>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        {t(
          "Worktrees linked to threads in this environment. Missing directories are shown separately; ordinary working folders are excluded.",
        )}
      </Text>
      {supportsReports ? (
        <View className="gap-2">
          <Text className="text-sm text-foreground">{t("Recent cleanup results")}</Text>
          <Text className="text-xs text-foreground-muted">
            {report.data
              ? new Date(report.data.finishedAt).toLocaleString()
              : t(
                  report.error
                    ? "Could not load recent cleanup results."
                    : "No cleanup results since this server started.",
                )}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {t("Shown results: {removed} removed, {kept} retained, {failed} failed", cleanupCounts)}
          </Text>
          {cleanupEntries.map((entry) => (
            <Text
              key={`${entry.kind}:${entry.path}:${entry.threadId}`}
              className="text-xs text-foreground-muted"
            >
              {entry.path}: {t(entry.reason)}
            </Text>
          ))}
        </View>
      ) : null}
      {(["Current worktrees", "Needs attention", "Missing working directories"] as const).map(
        (section) => {
          const entries = rows.filter((group) => managedWorktreeSection(group) === section);
          if (entries.length === 0) return null;
          return (
            <View key={section}>
              {section === "Missing working directories" ? (
                <Button
                  tone="text"
                  label={`${t(section)} (${entries.length})`}
                  onPress={() => setShowHistory((value) => !value)}
                />
              ) : (
                <Text className="text-sm font-t3-medium text-foreground">
                  {t(section)} ({entries.length})
                </Text>
              )}
              {section !== "Missing working directories" || showHistory
                ? entries.map((group) => (
                    <View key={group.id} className="gap-2 border-t border-border py-3">
                      <Text className="text-sm font-t3-medium text-foreground">
                        {group.projectTitle}
                      </Text>
                      <SelectionRow
                        title={group.title}
                        subtitle={t(
                          group.status === "removed"
                            ? "Working directory missing"
                            : "{count} worktrees",
                          {
                            count: group.resources.filter(
                              (resource) =>
                                resource.inspection === "linked" ||
                                (resource.inspection === undefined && resource.present),
                            ).length,
                          },
                        )}
                        role="checkbox"
                        selected={selected.has(group.id)}
                        disabled={!allowed || busy || !canRemoveManagedWorktree(group)}
                        onPress={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(group.id)) next.delete(group.id);
                            else next.add(group.id);
                            return next;
                          })
                        }
                      />
                      <Button
                        label={t("{count} linked threads", { count: group.threads.length })}
                        tone="text"
                        onPress={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(group.id)) next.delete(group.id);
                            else next.add(group.id);
                            return next;
                          })
                        }
                      />
                      {expanded.has(group.id) ? (
                        <View className="gap-2">
                          {group.threads.map((thread) => (
                            <Button
                              key={thread.id}
                              label={thread.title}
                              tone="text"
                              onPress={() => openThread({ environmentId, threadId: thread.id })}
                            />
                          ))}
                          {group.resources.map((resource) => (
                            <View key={resource.path}>
                              <Text className="text-sm text-foreground">
                                {resource.name} /{" "}
                                {resource.branch ??
                                  t(
                                    resource.branchSource === "git"
                                      ? "Detached HEAD"
                                      : "Unknown branch",
                                  )}
                                {resource.branchSource === "history"
                                  ? ` · ${t("Historical branch")}`
                                  : null}
                              </Text>
                              <Text selectable className="text-xs text-foreground-muted">
                                {resource.path}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                      {group.reason ? (
                        <Text className="text-xs text-foreground-muted">{t(group.reason)}</Text>
                      ) : null}
                      {group.recoveryPending ? (
                        <Button
                          label={t("Rebuild worktrees")}
                          icon="arrow.clockwise"
                          disabled={!restoreAllowed || busy || !canRestoreManagedWorktree(group)}
                          onPress={() => void rebuild(group)}
                        />
                      ) : group.status !== "removed" &&
                        group.resources.some(
                          (resource) =>
                            resource.inspection === "linked" ||
                            (resource.inspection === undefined && resource.present),
                        ) ? (
                        <Button
                          label={t("Clean worktrees")}
                          icon="trash"
                          tone="text"
                          disabled={!allowed || busy || !canRemoveManagedWorktree(group)}
                          onPress={() => clean([group])}
                        />
                      ) : null}
                      <Button
                        label={t("Copy path")}
                        tone="text"
                        onPress={() =>
                          void copyTextWithHaptic(
                            group.resources.map((resource) => resource.path).join("\n"),
                          )
                        }
                      />
                      {managedWorktreeSection(group) === "Needs attention" ? (
                        <Button
                          label={t("Retry inspection")}
                          tone="text"
                          disabled={busy || query.isPending}
                          onPress={query.refresh}
                        />
                      ) : null}
                    </View>
                  ))
                : null}
            </View>
          );
        },
      )}
      {selectedRows.length > 0 ? (
        <Button
          label={t("Clean selected ({count})", { count: selectedRows.length })}
          icon="trash"
          tone="danger"
          disabled={!allowed || busy || query.isPending}
          onPress={() => clean(selectedRows)}
        />
      ) : null}
      {results.map((result) => (
        <Text key={result.id} className="text-xs text-foreground-muted">
          {rows.find((group) => group.id === result.id)?.title}: {t(result.detail)}
        </Text>
      ))}
    </View>
  );
}

export function ManagedWorktreesSection(props: {
  environmentId: EnvironmentId;
  label: string;
  projectIds?: readonly ProjectId[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title="Local worktrees">
      <SettingsRow icon="internaldrive" label={props.label} onPress={() => setOpen(!open)} />
      {open ? <WorktreeList {...props} /> : null}
    </SettingsSection>
  );
}
