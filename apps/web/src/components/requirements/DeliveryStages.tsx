import type { DeliverySummary, IssueProvider } from "@t3tools/contracts";
import { deliveryStages } from "@t3tools/client-runtime/work-item";
import { CheckIcon, MinusIcon } from "lucide-react";
import { useUiTranslation } from "../../hooks/useUiTranslation";

export function DeliveryStages({
  provider,
  summary,
}: {
  provider: IssueProvider;
  summary?: DeliverySummary | undefined;
}) {
  const t = useUiTranslation();
  return (
    <ol aria-label={t("Delivery progress")} className="grid grid-cols-5 gap-1 py-3">
      {deliveryStages(provider, summary).map((stage) => (
        <li
          key={stage.key}
          className="flex min-w-0 flex-col items-center gap-1.5 text-center text-xs"
        >
          <span
            className={`flex size-5 items-center justify-center rounded-full ${stage.state === "complete" ? "bg-success/10 text-success" : stage.state === "active" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}
          >
            {stage.state === "complete" ? (
              <CheckIcon className="size-3" />
            ) : stage.state === "skipped" ? (
              <MinusIcon className="size-3" />
            ) : (
              <span className="size-1.5 rounded-full bg-current" />
            )}
          </span>
          <span>{t(stage.label)}</span>
          <span className="text-2xs text-muted-foreground">
            {t(
              stage.state === "unknown"
                ? "Unverified"
                : stage.state === "skipped"
                  ? "Not required"
                  : stage.state === "complete"
                    ? "Completed"
                    : stage.state === "active"
                      ? "In progress"
                      : "Pending",
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
