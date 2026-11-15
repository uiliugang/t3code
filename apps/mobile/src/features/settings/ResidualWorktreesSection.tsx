import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ResidualWorktree } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { formatBytes } from "../../lib/formatBytes";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ResidualWorktreesSection({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const [open, setOpen] = useState(false);
  const query = useEnvironmentQuery(
    open ? serverEnvironment.residualWorktrees({ environmentId, input: {} }) : null,
  );
  const allowed = useAtomValue(
    serverEnvironment.removeResidualWorktrees.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(serverEnvironment.removeResidualWorktrees);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = query.data?.directories ?? [];
  const results = query.data?.results ?? [];
  const selection = rows.filter((row) => selected.has(row.id) && row.reason === null);
  const clean = (targets: ReadonlyArray<ResidualWorktree>) => {
    Dialog.confirm({
      title: t("Permanently delete {count} folders?", { count: targets.length }),
      message: [
        t(
          "All source files, local changes, untracked and ignored files will be permanently deleted without a backup or trash. Independent repositories lose their Git history too. References and running resources are checked again before deletion.",
        ),
        ...targets.map(
          (row) =>
            `${row.path}${row.kind === "repository" ? `\n${t("Independent repository: its Git history will also be deleted.")}` : ""}`,
        ),
      ].join("\n\n"),
      confirmText: t("Permanently delete"),
      cancelText: t("Cancel"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusy(true);
          setError(null);
          const result = await remove({
            environmentId,
            input: { targets: targets.map(({ id, fingerprint }) => ({ id, fingerprint })) },
          }).finally(() => setBusy(false));
          if (result._tag === "Success") {
            setSelected(new Set());
            query.refresh();
          } else if (!isAtomCommandInterrupted(result))
            setError(String(squashAtomCommandFailure(result)));
        })();
      },
    });
  };
  return (
    <View className="gap-2">
      <Button
        label={t("Clean historical leftovers")}
        tone="secondary"
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <>
          <Text className="text-xs text-foreground-muted">
            {t(
              "Unused folders in this environment. Select each folder to permanently delete all its files. Age and local changes do not determine eligibility.",
            )}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {t("Disk usage is an estimate; shared files may not free the displayed space.")}
          </Text>
          <Button
            label={t("Refresh")}
            tone="text"
            disabled={busy || query.isPending}
            onPress={query.refresh}
          />
          {query.isPending ? <Text>{t("Checking worktrees...")}</Text> : null}
          {query.error || error ? (
            <Text className="text-xs text-danger-foreground">{query.error ?? error}</Text>
          ) : null}
          {!query.isPending && !query.error && rows.length === 0 ? (
            <Text>{t("No historical leftovers found.")}</Text>
          ) : null}
          {rows.map((row) => (
            <View key={row.id} className="gap-2">
              <SelectionRow
                title={row.path}
                role="checkbox"
                selected={selected.has(row.id)}
                disabled={!allowed || busy || query.isPending || row.reason !== null}
                onPress={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  })
                }
              />
              <Text selectable className="text-xs">
                {row.path}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {t(
                  row.kind === "repository"
                    ? "Independent repository: its Git history will also be deleted."
                    : row.kind === "worktree"
                      ? "Linked worktree"
                      : "Working folder",
                )}{" "}
                · {row.bytes === null ? t("Size unavailable") : formatBytes(row.bytes)}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {row.threads.length === 0
                  ? t("No linked threads")
                  : row.threads
                      .map(
                        (thread) =>
                          `${thread.title} (${t(thread.deleted ? "Deleted thread" : "Thread still exists")})`,
                      )
                      .join(" · ")}
              </Text>
              {row.reason ? (
                <Text className="text-xs text-foreground-muted">{t(row.reason)}</Text>
              ) : null}
              {results.some((result) => result.id === row.id && result.outcome === "failed") ? (
                <Button
                  label={t("Retry cleanup")}
                  tone="text"
                  disabled={!allowed || busy || query.isPending || row.reason !== null}
                  onPress={() => clean([row])}
                />
              ) : null}
            </View>
          ))}
          <Button
            label={t("Permanently delete selected ({count})", { count: selection.length })}
            tone="danger"
            disabled={!allowed || busy || query.isPending || selection.length === 0}
            onPress={() => clean(selection)}
          />
          {results.map((result) => (
            <Text key={result.id} selectable className="text-xs">
              {result.id}: {t(result.detail)}
            </Text>
          ))}
        </>
      ) : null}
    </View>
  );
}
