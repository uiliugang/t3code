import { describe, expect, it } from "@effect/vitest";
import type { DeliveryScope, DeliveryEvidence } from "@t3tools/contracts";
import { decideDelivery } from "./deliveryDecision.ts";

const scope: DeliveryScope = {
  revision: 1,
  confirmedRevision: 1,
  requiredPullRequests: [
    "https://github.com/acme/app/pull/1",
    "https://github.com/acme/app/pull/2",
  ],
  changedServices: [
    { appkey: "acme.api", target: "production", revision: "abc123" },
    { appkey: "acme.worker", target: "production", revision: "def456" },
  ],
};
const evidence: DeliveryEvidence = {
  pullRequests: scope.requiredPullRequests.map((url) => ({ url, merged: true })),
  releases: [],
  planIds: [],
  anomaly: null,
};

describe("decideDelivery", () => {
  it("waits for every necessary PR and a current scope confirmation", () => {
    expect(
      decideDelivery("github", scope, { ...evidence, pullRequests: evidence.pullRequests.slice(1) })
        .nextAction,
    ).toBe("none");
    expect(decideDelivery("github", { ...scope, revision: 2 }, evidence).progress).toBe(
      "needs_confirmation",
    );
    expect(
      decideDelivery("github", { ...scope, requiredPullRequests: [] }, evidence).nextAction,
    ).toBe("none");
    expect(decideDelivery("github", scope, evidence).nextAction).toBe("complete_external");
  });

  it("creates MCM plans only after all necessary PRs merge", () => {
    expect(decideDelivery("meituan", scope, { ...evidence, pullRequests: [] }).progress).toBe(
      "awaiting_merge",
    );
    expect(decideDelivery("meituan", scope, evidence)).toEqual({
      progress: "awaiting_plan",
      nextAction: "create_mcm",
    });
    expect(decideDelivery("meituan", scope, { ...evidence, planIds: ["123"] }).progress).toBe(
      "awaiting_release",
    );
  });

  it("requires this version of every deployment target, not a historical plan", () => {
    const releases = scope.changedServices.map((service) => ({
      ...service,
      planId: "123",
      completed: true,
    }));
    expect(
      decideDelivery("meituan", scope, { ...evidence, releases: [releases[0]!], planIds: ["123"] })
        .progress,
    ).toBe("partially_released");
    expect(
      decideDelivery("meituan", scope, {
        ...evidence,
        releases: releases.map((entry) => ({ ...entry, revision: "old" })),
      }).nextAction,
    ).toBe("create_mcm");
    expect(decideDelivery("meituan", scope, { ...evidence, releases }).nextAction).toBe(
      "complete_external",
    );
    expect(decideDelivery("meituan", { ...scope, changedServices: [] }, evidence).progress).toBe(
      "needs_confirmation",
    );
    expect(
      decideDelivery("meituan", scope, {
        ...evidence,
        releases: releases.map((entry) => ({ ...entry, completed: false })),
      }).nextAction,
    ).toBe("create_mcm");
  });

  it("blocks completion for an anomaly and never automatically reopens", () => {
    expect(
      decideDelivery("github", scope, { ...evidence, anomaly: "Deployment rolled back" }),
    ).toEqual({ progress: "delivery_exception", nextAction: "none" });
  });
});
