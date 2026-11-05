import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import type { EnvironmentPresentation } from "~/state/environments";
import { SettingsSection } from "./settingsLayout";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Button } from "../ui/button";

function DaxiangSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const t = useUiTranslation();
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.daxiang);
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const value = draft ?? saved;
  return (
    <form
      className="grid gap-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave || busy || draft === null) return;
        setBusy(true);
        setError(false);
        void update({
          environmentId,
          input: {
            patch: {
              daxiang: { clientId: value.clientId.trim(), clientSecret: value.clientSecret },
            },
          },
        }).then((result) => {
          setBusy(false);
          if (result._tag === "Success") setDraft(null);
          else setError(true);
        });
      }}
    >
      <h3 className="text-sm font-medium">
        {t("DaXiang")} · {label}
      </h3>
      <div className="grid gap-3 sm:max-w-sm">
        <div className="grid gap-1.5">
          <Label htmlFor={`dx-id-${environmentId}`}>Client ID</Label>
          <Input
            id={`dx-id-${environmentId}`}
            value={value.clientId}
            disabled={!canSave || busy}
            autoComplete="off"
            onChange={(event) => setDraft({ ...value, clientId: event.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`dx-secret-${environmentId}`}>Client Secret</Label>
          <Input
            id={`dx-secret-${environmentId}`}
            type="password"
            value={value.clientSecret}
            disabled={!canSave || busy}
            autoComplete="new-password"
            onChange={(event) => setDraft({ ...value, clientSecret: event.target.value })}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t("Could not save DaXiang credentials.")}
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={!canSave || busy || draft === null}>
          {t(busy ? "Saving..." : "Save")}
        </Button>
      </div>
    </form>
  );
}

export function CommunicationSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const t = useUiTranslation();
  return (
    <SettingsSection id="communication" title={t("Communication")}>
      {environments.map((environment) => (
        <DaxiangSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
    </SettingsSection>
  );
}
