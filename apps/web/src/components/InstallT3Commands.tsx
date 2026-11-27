import { cn } from "~/lib/utils";
import { CLI_INSTALL_SCRIPT_URL } from "@t3tools/shared/cliRelease";
import { useUiTranslation } from "../hooks/useUiTranslation";

import { CommandBlock } from "./CommandBlock";

/**
 * Setup steps for a macOS or Linux host: install `t3`, then run `command`.
 */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  const t = useUiTranslation();
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">macOS, Linux</p>
      <CommandBlock command={`curl -fsSL ${CLI_INSTALL_SCRIPT_URL} | sh`} />
      <p className="text-xs text-muted-foreground">{t("Then")}</p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        {t(
          "Skip the install if you already have t3. If t3 is not found after installing, add the folder the installer names to your PATH.",
        )}
      </p>
    </div>
  );
}
