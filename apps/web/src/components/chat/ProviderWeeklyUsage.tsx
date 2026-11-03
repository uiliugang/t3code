import { useUiTranslation } from "../../hooks/useUiTranslation";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { collectProviderWeeklyUsage } from "./ProviderWeeklyUsage.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function ProviderWeeklyUsage({
  providers,
  showLabel = false,
}: {
  providers: ReadonlyArray<ProviderInstanceEntry>;
  showLabel?: boolean;
}) {
  const t = useUiTranslation();
  const items = collectProviderWeeklyUsage(providers);
  if (items.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t("Weekly remaining")}
      tabIndex={0}
      className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-3 overflow-x-auto rounded-full border border-border/70 bg-card/70 px-3 py-1.5 text-xs [-webkit-app-region:no-drag] [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-ring"
    >
      {items.map((item) => {
        const provider = providers.find((entry) => entry.instanceId === item.instanceId)!;
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
              <ProviderInstanceIcon
                driverKind={provider.driverKind}
                displayName={provider.displayName}
                accentColor={provider.accentColor}
                acpRegistryAgentId={provider.acpRegistryAgentId}
                acpRegistryIconUrl={provider.acpRegistryIconUrl}
                showBadge
                size="compact"
              />
              {showLabel ? (
                <span className="max-w-24 truncate text-foreground/85 sm:max-w-40">
                  {item.displayName}
                </span>
              ) : null}
              <span className="tabular-nums text-muted-foreground">
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
