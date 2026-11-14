import {
  assertSettingsFileSize,
  parseSettingsFile,
  projectConfigurationsForImport,
  serializeSettingsFile,
  type SettingsFile,
} from "@t3tools/client-runtime/settings-transfer";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DownloadIcon, UploadIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { useUiTranslation } from "../../hooks/useUiTranslation";

export function SettingsTransfer({
  title,
  titleControl,
  description,
  scope,
  canImport,
  createFile,
  importFile,
  environmentId = null,
  supportsProjectImport = false,
}: {
  title: string;
  titleControl?: ReactNode;
  description: string;
  scope: SettingsFile["scope"];
  canImport: boolean;
  createFile: () => Promise<SettingsFile>;
  importFile: (file: SettingsFile) => Promise<void>;
  environmentId?: EnvironmentId | null;
  supportsProjectImport?: boolean;
}) {
  const t = useUiTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<SettingsFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [materialize, setMaterialize] = useState(false);
  const [destinationDirectory, setDestinationDirectory] = useState("");
  const [importId, setImportId] = useState(randomUUID);
  const canClone = useAtomValue(
    sourceControlEnvironment.importProjectConfigurations.permissionAtom(environmentId),
  );
  const startImport = useAtomCommand(sourceControlEnvironment.importProjectConfigurations, {
    reportFailure: false,
  });
  const definitions = pending ? projectConfigurationsForImport(pending) : [];
  const requiresProjectCreation = pending?.scope === "project" && scope === "application";

  const reportError = (cause: unknown) => {
    const message = t(cause instanceof Error ? cause.message : "Could not transfer settings.");
    setError(message);
    toastManager.add({ type: "error", title: t("Settings transfer failed"), description: message });
  };

  const exportFile = async () => {
    setBusy(true);
    const result = await settlePromise(async () => {
      const contents = serializeSettingsFile(await createFile());
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `t3-code-${scope}-settings.json`;
      anchor.click();
      // Browsers must open the download stream before its object URL is revoked.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
    setBusy(false);
    if (result._tag === "Failure") reportError(squashAtomCommandFailure(result));
  };

  const readFile = async (file: File) => {
    setBusy(true);
    setError(null);
    const result = await settlePromise(async () => {
      assertSettingsFileSize(file.size);
      const parsed = parseSettingsFile(await file.text());
      if (
        parsed.scope !== scope &&
        !(supportsProjectImport && scope === "application" && parsed.scope === "project")
      )
        throw new Error(
          t(
            scope === "application"
              ? "Choose an application settings file."
              : "Choose a project settings file.",
          ),
        );
      return parsed;
    });
    setBusy(false);
    if (result._tag === "Failure") reportError(squashAtomCommandFailure(result));
    else {
      setPending(result.value);
      setMaterialize(result.value.scope === "project" && scope === "application");
      setImportId(randomUUID());
    }
  };

  const confirmImport = async () => {
    if (!pending || !canImport || busy || (materialize && !canClone)) return;
    setBusy(true);
    const result = await settlePromise(async () => {
      if (materialize) {
        if (!environmentId || definitions.length === 0)
          throw new Error(
            "This export has no clone information. Export it again from an updated environment.",
          );
        const started = await startImport({
          environmentId,
          input: {
            id: importId,
            projects: definitions,
            ...(destinationDirectory.trim()
              ? { destinationDirectory: destinationDirectory.trim() }
              : {}),
          },
        });
        if (started._tag === "Failure") throw squashAtomCommandFailure(started);
      }
      if (!materialize || pending.scope === "application") await importFile(pending);
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      reportError(
        new Error(
          t("Import did not finish. Some values may already have been saved. {error}", {
            error: t(cause instanceof Error ? cause.message : "Try again."),
          }),
          { cause },
        ),
      );
    } else {
      setPending(null);
      toastManager.add({
        type: "success",
        title: t(materialize ? "Repository import queued" : "Settings imported"),
      });
    }
  };

  return (
    <>
      <SettingsRow
        title={titleControl ?? title}
        description={description}
        control={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportFile()}>
              <UploadIcon /> {t("Export")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canImport}
              onClick={() => fileInput.current?.click()}
            >
              <DownloadIcon /> {t("Import")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void readFile(file);
              }}
            />
          </div>
        }
      />
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("Import settings into {title}?", { title })}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t(
                  materialize
                    ? "Repositories will be cloned on the selected environment and their projects or workspace groups restored."
                    : pending?.scope === "project"
                      ? "This replaces the checkout's project overrides. Missing settings inherit their defaults."
                      : "Imported values replace matching settings. Other settings stay as they are.",
                )}
                {pending?.scope === "project"
                  ? t(" Source: {name}. Project identifiers may differ when copying a template.", {
                      name: pending.name,
                    })
                  : t(
                      " This updates this client's preferences and the selected environment. Shortcuts are merged. Mobile-only preferences stay on mobile.",
                    )}
              </p>
              {requiresProjectCreation && definitions.length === 0 ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(
                    "This export has no clone information. Export it again from an updated environment.",
                  )}
                </p>
              ) : null}
              {supportsProjectImport && (definitions.length > 0 || requiresProjectCreation) ? (
                <div className="space-y-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={materialize}
                      disabled={busy || requiresProjectCreation || !canClone}
                      onCheckedChange={(checked) => setMaterialize(checked === true)}
                    />
                    {t("Clone repositories and create projects or workspace groups")}
                  </label>
                  {materialize ? (
                    <div className="space-y-2">
                      <Input
                        aria-label={t("Clone destination directory")}
                        placeholder={t(
                          "Optional directory on this environment (default: ~/projects)",
                        )}
                        value={destinationDirectory}
                        disabled={busy}
                        onChange={(event) => setDestinationDirectory(event.currentTarget.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "{count} project configurations. Repositories are deduplicated. Saved imports retain failures for retry.",
                          { count: definitions.length },
                        )}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {pending ? (
                <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(pending, null, 2)}
                </pre>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>
                  {t("Cancel")}
                </Button>
                <Button
                  disabled={
                    busy || !canImport || (materialize && (!canClone || definitions.length === 0))
                  }
                  onClick={() => void confirmImport()}
                >
                  {t(busy ? "Importing…" : "Import settings")}
                </Button>
              </div>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
