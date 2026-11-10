import { useState } from "react";
import { PencilIcon } from "lucide-react";
import { AuthSettingsWriteScope, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { useEnvironmentScope } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MenuSub, MenuSubTrigger, MenuSubPopup } from "../ui/menu";

export function EnvironmentNameMenu({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment" | "settings"> | null;
}) {
  const t = useUiTranslation();
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "rename environment",
    reportFailure: true,
  });
  const [pending, setPending] = useState(false);
  const name = serverConfig?.settings.environmentName ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? name;
  const disabled =
    !allowed || serverConfig?.environment.capabilities.environmentName !== true || pending;
  const save = async (environmentName: string | null) => {
    if (disabled) return;
    setPending(true);
    const result = await update({ environmentId, input: { patch: { environmentName } } });
    setPending(false);
    if (result._tag === "Success") setDraft(null);
  };
  return (
    <MenuSub>
      <MenuSubTrigger disabled={disabled}>
        <PencilIcon />
        {t("Rename environment")}
      </MenuSubTrigger>
      <MenuSubPopup>
        <form
          className="flex w-64 flex-col gap-3 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save(value.trim());
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
          }}
        >
          <Input
            aria-label={t("Environment name")}
            placeholder={serverConfig?.environment.defaultLabel ?? serverConfig?.environment.label}
            value={value}
            maxLength={100}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending || name === ""}
              onClick={() => void save(null)}
            >
              {t("Restore default name")}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={pending || value.trim() === "" || value.trim() === name}
            >
              {t(pending ? "Saving…" : "Save")}
            </Button>
          </div>
        </form>
      </MenuSubPopup>
    </MenuSub>
  );
}
