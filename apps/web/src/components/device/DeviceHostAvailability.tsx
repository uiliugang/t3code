import type { DevicePlatformAvailability } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { Check, Minus } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

export function DeviceHostAvailability({
  platforms,
}: {
  platforms: ReadonlyArray<DevicePlatformAvailability>;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {platforms.map(({ platform, available, reason }) => {
        const name = platform === "ios" ? "iOS" : "Android";
        const label = available
          ? gt("{platform} available", { platform: name })
          : gt("{platform} unavailable", { platform: name });
        return (
          <Tooltip key={platform}>
            <TooltipTrigger
              render={<span tabIndex={0} className="inline-flex items-center gap-1" />}
            >
              {available ? <Check className="size-3" /> : <Minus className="size-3" />}
              {label}
            </TooltipTrigger>
            <TooltipPopup>{reason ?? label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
