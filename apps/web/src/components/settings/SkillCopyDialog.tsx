import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon, CircleAlertIcon, CopyIcon, FileIcon, FolderIcon } from "lucide-react";
import {
  type EnvironmentId,
  type SkillCopyPreview,
  type SkillCopySource,
} from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Alert, AlertDescription } from "../ui/alert";

export function SkillCopyDialog({
  environmentId,
  items,
  onClose,
}: {
  environmentId: EnvironmentId;
  items: ReadonlyArray<{ name: string; source: SkillCopySource }>;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const { environments } = useEnvironments();
  const targets = environments.filter((env) => env.environmentId !== environmentId);
  const [targetId, setTargetId] = useState<EnvironmentId | null>(
    targets.find((env) => env.connection.phase === "connected")?.environmentId ?? null,
  );
  const [directory, setDirectory] = useState<string | null>(null);
  const [preview, setPreview] = useState<SkillCopyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [error, setError] = useState("");
  const query = useEnvironmentQuery(
    serverEnvironment.skills({ environmentId: targetId ?? environmentId, input: {} }),
  );
  const permitted = useAtomValue(
    serverEnvironment.copySkill.permissionAtom(targetId ?? environmentId),
  );
  const sourcePermitted = useAtomValue(serverEnvironment.exportSkill.permissionAtom(environmentId));
  const exportSkill = useAtomCommand(serverEnvironment.exportSkill);
  const copySkill = useAtomCommand(serverEnvironment.copySkill);
  const previewCopy = useAtomCommand(serverEnvironment.previewSkillCopy);
  const target = targets.find((env) => env.environmentId === targetId);
  const destination =
    directory ??
    query.data?.targets.find((entry) => entry.id === "directory:shared")?.directory ??
    "";
  const canCopy =
    !!target && target.connection.phase === "connected" && permitted && sourcePermitted;
  const remaining = items.filter((item) => !submitted.includes(item.name));
  const review = async () => {
    if (!targetId) return;
    setBusy(true);
    setError("");
    const result = await previewCopy({
      environmentId: targetId,
      input: { directory: destination, names: items.map((item) => item.name) },
    });
    if (result._tag === "Success") setPreview(result.value);
    else
      setError(t("Could not preview the destination. Check its connection, permissions and path."));
    setBusy(false);
  };
  const submit = async () => {
    if (!targetId || !preview) return;
    setBusy(true);
    setError("");
    for (const item of remaining) {
      const exported = await exportSkill({ environmentId, input: item.source });
      if (exported._tag !== "Success" || exported.value.name !== item.name) {
        setError(t("Could not copy {name}. Refresh the source and retry.", { name: item.name }));
        break;
      }
      const copied = await copySkill({
        environmentId: targetId,
        input: { directory: preview.directory, package: exported.value },
      });
      if (copied._tag !== "Success") {
        setError(t("Could not copy {name}. Check the destination and retry.", { name: item.name }));
        break;
      }
      setSubmitted((current) => [...current, item.name]);
    }
    setBusy(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Copy to another environment")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {new Set(items.map((item) => item.name)).size !== items.length && (
              <p role="alert" className="text-sm text-destructive">
                {t(
                  "Duplicate names selected: {names}. Close this dialog and select only one source for each name.",
                  {
                    names: [
                      ...new Set(
                        items
                          .filter(
                            (item, index) =>
                              items.findIndex((other) => other.name === item.name) !== index,
                          )
                          .map((item) => item.name),
                      ),
                    ].join(", "),
                  },
                )}
              </p>
            )}
            <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              <span className="truncate">
                {environments.find((env) => env.environmentId === environmentId)?.label}
              </span>
              <ArrowRightIcon className="size-3.5 shrink-0" />
              <span className="truncate">{target?.label ?? t("Choose environment")}</span>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium">{t("Destination environment")}</label>
              <Select
                value={targetId ?? ""}
                onValueChange={(id) => {
                  setTargetId(
                    targets.find((env) => env.environmentId === id)?.environmentId ?? null,
                  );
                  setDirectory(null);
                  setPreview(null);
                  setError("");
                }}
                disabled={busy || submitted.length > 0}
              >
                <SelectTrigger aria-label={t("Destination environment")}>
                  <SelectValue>{target?.label ?? t("Choose environment")}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {targets.map((env) => (
                    <SelectItem
                      key={env.environmentId}
                      value={env.environmentId}
                      disabled={env.connection.phase !== "connected"}
                    >
                      {env.label}
                      {env.displayUrl ? ` · ${env.displayUrl}` : ""}
                      {env.connection.phase !== "connected"
                        ? ` · ${t("Environment disconnected")}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="skill-copy-path" className="text-xs font-medium">
                {t("Destination directory")}
              </label>
              <Input
                id="skill-copy-path"
                value={destination}
                disabled={busy || submitted.length > 0}
                onChange={(event) => {
                  setDirectory(event.target.value);
                  setPreview(null);
                }}
              />
            </div>
            {!targets.length && (
              <p className="text-sm text-muted-foreground">
                {t("Connect another environment to copy skills.")}
              </p>
            )}
            {targetId && !canCopy && (
              <p role="alert" className="text-sm text-muted-foreground">
                {t("Both environments must be connected with permission to manage skills.")}
              </p>
            )}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">
                  {t("{count} skills", { count: items.length })}
                </span>
                <span className="text-xs text-muted-foreground">{t("Current version only")}</span>
              </div>
              {items.map((item) => {
                const entry = preview?.entries.find((entry) => entry.name === item.name);
                const sent = submitted.includes(item.name);
                return (
                  <div key={item.name} className="flex min-w-0 items-center gap-3 border-t py-3">
                    <span className="text-muted-foreground">
                      {entry?.status === "directory" ? (
                        <FolderIcon className="size-4" />
                      ) : (
                        <FileIcon className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 break-all text-sm font-medium">
                      {item.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t(
                        sent
                          ? "Queued"
                          : !entry
                            ? "Not checked"
                            : entry.status === "new"
                              ? "New"
                              : entry.status === "skill"
                                ? "Overwrite skill"
                                : "Overwrite directory",
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {preview?.entries.some((entry) => entry.status !== "new") && (
              <Alert>
                <CircleAlertIcon />
                <AlertDescription>
                  {t(
                    "Matching skills or directories will be fully replaced, including old files missing from the source. Other directories are unchanged.",
                  )}
                </AlertDescription>
              </Alert>
            )}
            {submitted.length > 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                {t(
                  "{count} queued. View results in Recent operations on the destination environment.",
                  { count: submitted.length },
                )}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t(remaining.length ? "Cancel" : "Done")}
          </Button>
          {remaining.length > 0 && (
            <Button
              disabled={
                busy ||
                !canCopy ||
                !destination ||
                new Set(items.map((item) => item.name)).size !== items.length
              }
              onClick={() => void (preview ? submit() : review())}
            >
              <CopyIcon />
              {t(busy ? "Working..." : preview ? "Copy and overwrite ({count})" : "Preview copy", {
                count: remaining.length,
              })}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
