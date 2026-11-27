import type { DevicePlatformAvailability } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { Check, Minus } from "lucide-react";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function DeviceHostAvailability({
  platforms,
}: {
  platforms: ReadonlyArray<DevicePlatformAvailability>;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {platforms.map((platform) => {
        const name = platform.platform === "ios" ? "iOS" : "Android";
        const availability = platform.available
          ? gt("{platform} available", { platform: name })
          : gt("{platform} unavailable", { platform: name });
        return (
          <SharedTooltipTrigger
            key={platform.platform}
            render={<span tabIndex={0} className="inline-flex items-center gap-1" />}
            label={platform.reason ?? availability}
          >
            {platform.available ? <Check className="size-3" /> : <Minus className="size-3" />}
            {availability}
          </SharedTooltipTrigger>
        );
      })}
    </div>
  );
}
