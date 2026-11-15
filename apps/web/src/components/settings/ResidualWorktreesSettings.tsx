import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ResidualWorktree } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { formatBytes } from "../../lib/formatBytes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";

export function ResidualWorktreesSettings({ environmentId }: { environmentId: EnvironmentId }) {
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
  const [confirmation, setConfirmation] = useState<ReadonlyArray<ResidualWorktree> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = query.data?.directories ?? [];
  const results = query.data?.results ?? [];
  const selection = rows.filter((row) => selected.has(row.id) && row.reason === null);
  const clean = async () => {
    if (!confirmation || busy) return;
    setBusy(true);
    setError(null);
    const result = await remove({
      environmentId,
      input: { targets: confirmation.map(({ id, fingerprint }) => ({ id, fingerprint })) },
    }).finally(() => setBusy(false));
    if (result._tag === "Success") {
      setConfirmation(null);
      setSelected(new Set());
      query.refresh();
    } else if (!isAtomCommandInterrupted(result))
      setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <div className="space-y-3 border-y border-border/50 py-3">
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t("Clean historical leftovers")}
      </Button>
      {open ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t(
              "Unused folders in this environment. Select each folder to permanently delete all its files. Age and local changes do not determine eligibility.",
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("Disk usage is an estimate; shared files may not free the displayed space.")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || query.isPending}
            onClick={query.refresh}
          >
            {t("Refresh")}
          </Button>
          {query.isPending ? (
            <p role="status" className="text-xs">
              {t("Checking worktrees...")}
            </p>
          ) : null}
          {query.error || error ? (
            <p role="alert" className="wrap-anywhere text-xs text-destructive">
              {query.error ?? error}
            </p>
          ) : null}
          {!query.isPending && !query.error && rows.length === 0 ? (
            <p className="text-xs">{t("No historical leftovers found.")}</p>
          ) : null}
          {rows.map((row) => (
            <div key={row.id} className="space-y-2 border-t border-border/50 py-3">
              <label className="flex min-h-11 items-start gap-2">
                <Checkbox
                  checked={selected.has(row.id)}
                  disabled={!allowed || busy || query.isPending || row.reason !== null}
                  onCheckedChange={(value) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (value) next.add(row.id);
                      else next.delete(row.id);
                      return next;
                    })
                  }
                />
                <code className="min-w-0 select-text wrap-anywhere text-xs">{row.path}</code>
              </label>
              <p className="text-xs text-muted-foreground">
                {t(
                  row.kind === "repository"
                    ? "Independent repository: its Git history will also be deleted."
                    : row.kind === "worktree"
                      ? "Linked worktree"
                      : "Working folder",
                )}{" "}
                · {row.bytes === null ? t("Size unavailable") : formatBytes(row.bytes)}
              </p>
              <p className="wrap-anywhere text-xs text-muted-foreground">
                {row.threads.length === 0
                  ? t("No linked threads")
                  : row.threads
                      .map(
                        (thread) =>
                          `${thread.title} (${t(thread.deleted ? "Deleted thread" : "Thread still exists")})`,
                      )
                      .join(" · ")}
              </p>
              {row.reason ? (
                <p className="wrap-anywhere text-xs text-muted-foreground">{t(row.reason)}</p>
              ) : null}
              {results.some((result) => result.id === row.id && result.outcome === "failed") ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!allowed || busy || query.isPending || row.reason !== null}
                  onClick={() => setConfirmation([row])}
                >
                  {t("Retry cleanup")}
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            variant="destructive"
            size="sm"
            disabled={!allowed || busy || query.isPending || selection.length === 0}
            onClick={() => setConfirmation(selection)}
          >
            {t("Permanently delete selected ({count})", { count: selection.length })}
          </Button>
          {!allowed ? (
            <p className="text-xs text-muted-foreground">
              {t("This connection cannot manage worktrees.")}
            </p>
          ) : null}
          {results.map((result) => (
            <p key={result.id} role="status" className="wrap-anywhere text-xs">
              <code>{result.id}</code>: {t(result.detail)}
            </p>
          ))}
        </>
      ) : null}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Permanently delete {count} folders?", { count: confirmation?.length ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "All source files, local changes, untracked and ignored files will be permanently deleted without a backup or trash. Independent repositories lose their Git history too. References and running resources are checked again before deletion.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-64 space-y-2 overflow-y-auto text-xs">
            {confirmation?.map((row) => (
              <li key={row.id} className="wrap-anywhere">
                <code>{row.path}</code>
                {row.kind === "repository" ? (
                  <p className="text-destructive">
                    {t("Independent repository: its Git history will also be deleted.")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" disabled={!allowed || busy} onClick={() => void clean()}>
              {t(busy ? "Cleaning..." : "Permanently delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
