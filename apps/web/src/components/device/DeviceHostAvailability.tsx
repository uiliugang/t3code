import type { DevicePlatformAvailability } from "@t3tools/contracts";
import { Check, Minus } from "lucide-react";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

export function DeviceHostAvailability({
  platforms,
}: {
  platforms: ReadonlyArray<DevicePlatformAvailability>;
}) {
  const t = useUiTranslation();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {platforms.map((platform) => (
        <Tooltip key={platform.platform}>
          <TooltipTrigger render={<span tabIndex={0} className="inline-flex items-center gap-1" />}>
            {platform.available ? <Check className="size-3" /> : <Minus className="size-3" />}
            {t(platform.available ? "{platform} available" : "{platform} unavailable", {
              platform: platform.platform === "ios" ? "iOS" : "Android",
            })}
          </TooltipTrigger>
          <TooltipPopup>
            {platform.reason ??
              t(platform.platform === "ios" ? "iOS available" : "Android available")}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
