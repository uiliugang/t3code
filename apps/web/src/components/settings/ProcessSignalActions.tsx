import { useUiTranslation } from "~/hooks/useUiTranslation";
import type { ServerProcessSignal } from "@t3tools/contracts";

import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ProcessSignalActions({
  disabled,
  onSignal,
}: {
  disabled: boolean;
  onSignal: (signal: ServerProcessSignal) => void;
}) {
  const t = useUiTranslation();
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label={t("Send SIGINT")}
              tone="muted"
              onClick={() => onSignal("SIGINT")}
            >
              INT
            </InlineButton>
          }
        />
        <TooltipPopup side="top">{t("Send SIGINT")}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label={t("Send SIGKILL")}
              tone="destructive"
              onClick={() => onSignal("SIGKILL")}
            >
              KILL
            </InlineButton>
          }
        />
        <TooltipPopup side="top">{t("Send SIGKILL")}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
