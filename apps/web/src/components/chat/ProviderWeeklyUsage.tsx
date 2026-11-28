import { useUiTranslation } from "../../hooks/useUiTranslation";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { collectProviderWeeklyUsage } from "./ProviderWeeklyUsage.logic";

/** A ring that closes as the weekly allowance is used; empty when the share is unknown. */
function UsageRing({ remaining }: { remaining: number | null }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90">
      <circle
        cx="8"
        cy="8"
        r="5.75"
        fill="none"
        strokeWidth="2.5"
        className="stroke-foreground/15"
      />
      {remaining === null ? null : (
        <circle
          cx="8"
          cy="8"
          r="5.75"
          fill="none"
          strokeWidth="2.5"
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={100 - remaining}
          strokeLinecap="round"
          className="stroke-primary"
        />
      )}
    </svg>
  );
}

export function ProviderWeeklyUsage({
  providers,
}: {
  providers: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const t = useUiTranslation();
  const items = collectProviderWeeklyUsage(providers);
  if (items.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t("Weekly remaining")}
      tabIndex={0}
      className="flex h-7.5 min-w-0 max-w-1/2 shrink-0 items-center gap-2.5 overflow-x-auto rounded-full bg-foreground/[0.11] px-1 ps-2 pe-2.5 text-xs [-webkit-app-region:no-drag] [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-ring"
    >
      {items.map((item) => {
        const label =
          item.remaining === null
            ? t("{provider}: weekly usage unavailable", { provider: item.displayName })
            : t("{provider}: {percent}% weekly remaining", {
                provider: item.displayName,
                percent: item.remaining,
              });
        return (
          <Tooltip key={item.instanceId}>
            <TooltipTrigger
              render={<span aria-label={label} className="flex shrink-0 items-center gap-1.5" />}
            >
              <UsageRing remaining={item.remaining} />
              <span className="max-w-24 truncate text-foreground/85 sm:max-w-40">
                {item.displayName}
              </span>
              <span className="font-semibold tabular-nums text-foreground">
                {item.remaining === null ? "--" : `${item.remaining}%`}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
