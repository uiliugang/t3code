import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  migrateVirtualModels,
  resolveVirtualModel,
  virtualModelReference,
  virtualModelFitsRole,
} from "./virtualModels.ts";

describe("virtual model settings", () => {
  const text = {
    instanceId: ProviderInstanceId.make("custom"),
    model: "custom-model",
    options: [{ id: "tier", value: "fast" }],
  };
  it("seeds from current settings once, retaining options, inheritance, and no fallback", () => {
    const next = migrateVirtualModels({
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: text,
      fallbackModelSelection: null,
    });
    expect(next.textGenerationModelSelection).toEqual(
      virtualModelReference("textGenerationModelSelection"),
    );
    expect(next.fallbackModelSelection).toBeNull();
    expect(resolveVirtualModel(next, next.speechPostProcessingModelSelection)).toEqual(text);
    const direct = { ...next, textGenerationModelSelection: { ...text, model: "another" } };
    expect(migrateVirtualModels(direct)).toBe(direct);
    expect(resolveVirtualModel(direct, direct.speechPostProcessingModelSelection)).toBe(
      direct.textGenerationModelSelection,
    );
  });
  it("keeps missing and cyclic references unresolved and reuses the original reference after binding", () => {
    const next = migrateVirtualModels(DEFAULT_SERVER_SETTINGS);
    const ref = virtualModelReference("team");
    expect(resolveVirtualModel(next, ref)).toEqual(ref);
    expect(
      resolveVirtualModel(
        {
          ...next,
          textGenerationModelSelection: ref,
          virtualModels: { team: { binding: "textGenerationModelSelection" } },
        },
        ref,
      ),
    ).toEqual(ref);
    expect(
      resolveVirtualModel({ ...next, virtualModels: { team: { binding: text } } }, ref),
    ).toEqual(text);
  });
  it("checks the destination binding for each role while allowing an unbound reference", () => {
    const role = "defaultModelSelection";
    const base = migrateVirtualModels(DEFAULT_SERVER_SETTINGS);
    const team = { binding: { ...text, instanceId: ProviderInstanceId.make("codex") } };
    const settings = { ...base, virtualModels: { team } };
    expect(virtualModelFitsRole(settings, "team", role)).toBe(true);
    expect(
      virtualModelFitsRole(
        {
          ...settings,
          textGenerators: {
            [team.binding.instanceId]: {
              kind: "openaiCompatible",
              apiKey: "",
              enabled: true,
              baseUrl: "https://example.test",
            },
          },
        },
        "team",
        role,
      ),
    ).toBe(false);
    expect(
      virtualModelFitsRole(
        { ...settings, virtualModels: { team: { binding: null } } },
        "team",
        role,
      ),
    ).toBe(true);
    expect(
      virtualModelFitsRole(
        { ...settings, virtualModels: { team: { binding: "textGenerationModelSelection" } } },
        "team",
        "textGenerationModelSelection",
      ),
    ).toBe(false);
  });
});
