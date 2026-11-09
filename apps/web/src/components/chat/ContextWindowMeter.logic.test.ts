import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveContextWindowModelDisplayName,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);
    expect(
      resolveContextWindowModelDisplayName(
        { instanceId: selectedInstanceId, model: "gpt-5.6-sol" },
        modelOptionsByInstance,
      ),
    ).toBe("GPT-5.6 Sol");
  });
});

describe("shouldReserveContextWindowMeter", () => {
  it.each([true, null])(
    "holds the slot while a started thread loads with reported capability %s",
    (providerReportsContextWindow) => {
      expect(
        shouldReserveContextWindowMeter({
          meterEnabled: true,
          detailLoading: true,
          threadStarted: true,
          providerReportsContextWindow,
        }),
      ).toBe(true);
    },
  );
});
