import type { DaxiangApprovalOutcome, ServerSettings } from "@t3tools/contracts";
import type { ParsedApprovalTarget } from "./daxiangApprovalLinks.ts";

export { boundedAdd } from "@t3tools/shared/boundedSet";

export function shouldRememberApprovalOutcome(
  outcome: DaxiangApprovalOutcome,
  detail: string | null,
): boolean {
  return (
    outcome === "approved" ||
    outcome === "notified" ||
    outcome === "opened" ||
    outcome === "deliveryUnknown" ||
    detail === "Already approved at this commit."
  );
}

export function approvalMessageKey(
  event: {
    readonly msgId?: string | undefined;
    readonly msgUuid?: string | undefined;
    readonly cts?: number | undefined;
    readonly sessionId: string;
  },
  targets: ReadonlyArray<ParsedApprovalTarget>,
  anonymousId: number,
): string {
  const id = event.msgUuid ?? event.msgId;
  if (id) return id;
  if (event.cts !== undefined) {
    return `${event.sessionId}:${event.cts}:${targets.map((target) => target.key).join(",")}`;
  }
  return `anonymous:${anonymousId}`;
}

export function isProductionMcmTarget(target: ParsedApprovalTarget): boolean {
  if (target.kind !== "mcm-plan" && target.kind !== "mcm-event") return true;
  return new URL(target.url).hostname.toLowerCase() !== "mcm.mws-test.sankuai.com";
}

export type DaxiangDeliveryStatus = "sent" | "failed" | "unknown" | "not_configured";

export function manualApprovalOutcome(input: {
  readonly browserOpened: boolean;
  readonly openError: string | null;
  readonly shouldNotify: boolean;
  readonly daXiangDelivery: DaxiangDeliveryStatus;
}): DaxiangApprovalOutcome {
  if (input.daXiangDelivery === "sent") return "notified";
  if (input.daXiangDelivery === "unknown") return "deliveryUnknown";
  if (input.browserOpened) return "opened";
  if (input.openError) return "failed";
  if (input.shouldNotify) return "localOnly";
  return "skipped";
}

export function autoApprovalDedupeKey(key: string): string {
  return `auto:${key}`;
}

export function shouldHandleMessageOutcome(outcome: DaxiangApprovalOutcome): boolean {
  return outcome !== "failed";
}

export function shouldReplyToSender(outcome: DaxiangApprovalOutcome): boolean {
  return (
    outcome === "approved" ||
    outcome === "notified" ||
    outcome === "opened" ||
    outcome === "deliveryUnknown"
  );
}

export function isSelfAuthoredApprovalEvent(
  event: { readonly fromUid?: string | undefined },
  ownUid: string | null | undefined,
): boolean {
  return ownUid !== null && ownUid !== undefined && event.fromUid === ownUid;
}

export function approvalWatchSettingsKey(
  settings: Pick<ServerSettings, "meituanIntegrationEnabled" | "daxiang" | "sourceControlHosts">,
): string {
  return JSON.stringify({
    meituanIntegrationEnabled: settings.meituanIntegrationEnabled,
    enabled: settings.daxiang.approvalMonitor.enabled,
    enhanceDumboWeb: settings.daxiang.approvalMonitor.enhanceDumboWeb,
    chromeCdpPort: settings.daxiang.approvalMonitor.chromeCdpPort,
  });
}
