import { useUiTranslation } from "~/hooks/useUiTranslation";
import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
}) {
  const t = useUiTranslation();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(sources);

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              {t("Add hub")}
            </Button>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow title={t("No hubs configured.")} />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    CLI Proxy{source.enabled ? "" : t(" · Disabled")}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const t = useUiTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {t("Remove")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remove {name}?", { name: label })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "The hub's management key is deleted from this server. Its accounts leave the Limits view; the hub itself is untouched. Add it again with the URL and key to bring them back.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {t("Remove hub")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
