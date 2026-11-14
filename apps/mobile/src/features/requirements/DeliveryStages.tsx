import type { DeliverySummary, IssueProvider } from "@t3tools/contracts";
import { deliveryStages } from "@t3tools/client-runtime/work-item";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useUiTranslation } from "../../lib/useUiTranslation";

export function DeliveryStages({
  provider,
  summary,
}: {
  provider: IssueProvider;
  summary?: DeliverySummary | undefined;
}) {
  const t = useUiTranslation();
  return (
    <View className="flex-row py-3">
      {deliveryStages(provider, summary).map((stage) => (
        <View key={stage.key} className="min-w-0 flex-1 items-center gap-2">
          <SymbolView
            name={
              stage.state === "complete"
                ? "checkmark.circle.fill"
                : stage.state === "skipped"
                  ? "minus"
                  : stage.state === "active"
                    ? "circle.inset.filled"
                    : "circle"
            }
            size={20}
            tintColorClassName={
              stage.state === "complete"
                ? "accent-success"
                : stage.state === "active"
                  ? "accent-primary"
                  : "accent-foreground-muted"
            }
          />
          <Text className="text-center text-xs">{t(stage.label)}</Text>
          <Text className="text-center text-[10px] text-foreground-muted">
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
          </Text>
        </View>
      ))}
    </View>
  );
}
