import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function DeliveryNotificationCoordinator() {
  const { environments } = useEnvironments();
  return environments.map((environment) =>
    environment.serverConfig?.workItemDelivery ? (
      <EnvironmentDeliveryNotifications
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    ) : null,
  );
}

function EnvironmentDeliveryNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const announced = useRef(new Set<string>());
  const result = useEnvironmentQuery(
    serverEnvironment.workItemsLive({
      environmentId,
      input: { attentionOnly: true, limit: 100 },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces newly observed delivery exceptions through the native dialog service
  useEffect(() => {
    const messages: string[] = [];
    for (const item of result.data?.items ?? []) {
      const summary = item.deliverySummary;
      if (item.archived || summary?.progress !== "delivery_exception") continue;
      const key = `${item.id}:${summary.revision}:${summary.error ?? ""}`;
      if (announced.current.has(key)) continue;
      announced.current.add(key);
      messages.push(item.title);
    }
    if (messages.length > 0) Dialog.alert(t("Delivery exception"), messages.join("\n"));
  }, [result.data, t]);
  return null;
}
