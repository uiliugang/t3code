import { useUiTranslation } from "~/hooks/useUiTranslation";
import { msg } from "gt-react";

import { APP_VERSION } from "../../branding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AboutVersionTitle() {
  const t = useUiTranslation();
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: {
      target: "version",
      unavailableMessage: msg("Clipboard API is unavailable while copying version."),
      failureMessage: msg("Failed to copy version to the clipboard."),
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not copy version"),
          description: error.message,
        }),
      );
    },
  });

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="shrink-0">{t("Version")}</span>
      <code className="text-2xs font-medium">
        <Tooltip>
          <TooltipTrigger
            render={
              <InlineButton
                tone="muted"
                aria-label={t("Copy version {version}", { version: APP_VERSION })}
                onClick={() => copyToClipboard(APP_VERSION, undefined)}
              >
                {APP_VERSION}
              </InlineButton>
            }
          />
          <TooltipPopup>{t("Copy version")}</TooltipPopup>
        </Tooltip>
      </code>
    </span>
  );
}
