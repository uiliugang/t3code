import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { translateUi } from "@t3tools/shared/uiLocale";
import {
  migrateVirtualModels,
  resolveVirtualModel,
  virtualModelReference,
  type VirtualModelRole,
} from "@t3tools/shared/virtualModels";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  bindingEditError,
  settingModelLabel,
  virtualModelEdit,
  virtualModelEditorParent,
  virtualModelUsage,
} from "./virtualModelEditor.ts";

const settings = migrateVirtualModels(DEFAULT_SERVER_SETTINGS);
const physical = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" };
const providers: ServerProvider[] = [
  {
    instanceId: physical.instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-21T00:00:00.000Z",
    models: [{ slug: physical.model, name: "Claude Sonnet", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
];
const t = translateUi.bind(null, "en");

it("unbinds only the saved entry and leaves the reference ready for rebinding", () => {
  const original = {
    ...settings,
    virtualModels: { team: { name: "Team", binding: physical } },
    defaultModelSelection: virtualModelReference("team"),
  };
  const renamed = applyServerSettingsPatch(original, {
    virtualModels: { team: { name: "Renamed", binding: physical } },
  });
  const patch = { virtualModels: { team: "unbind" } } as const;
  const cleared = applyServerSettingsPatch(renamed, patch);
  expect(cleared.virtualModels?.team).toEqual({ name: "Renamed", binding: null });
  const removed = applyServerSettingsPatch(original, { virtualModels: { team: null } });
  expect(applyServerSettingsPatch(removed, patch).virtualModels).toEqual({});
  expect(cleared.defaultModelSelection).toEqual(original.defaultModelSelection);
  expect(resolveVirtualModel(cleared, cleared.defaultModelSelection)).toEqual(
    virtualModelReference("team"),
  );
  const rebound = applyServerSettingsPatch(cleared, {
    virtualModels: { team: { name: "Team", binding: physical } },
  });
  expect(resolveVirtualModel(rebound, rebound.defaultModelSelection)).toEqual(physical);
  expect(virtualModelEdit(original.virtualModels.team, "team", " Changed ", physical, t)).toEqual({
    expected: original.virtualModels.team,
    save: { name: "Changed", binding: physical },
  });
});

it.each([
  ["team", "textGenerationModelSelection", "textGenerationModelSelection"],
  ["reviewGuideModelSelection", "textGenerationModelSelection", "textGenerationModelSelection"],
  ["reviewGuideModelSelection", physical, "sourceControlWriterModelSelection"],
  ["team", null, null],
] as const)("keeps the saved inheritance source for %s (%j)", (id, binding, expected) => {
  expect(virtualModelEditorParent(id, binding)).toBe(expected);
});

it("includes project review references and rejects inheritance cycles introduced only in a project", () => {
  const id = "speechPostProcessingModelSelection";
  const scoped = {
    ...settings,
    projectSettingsOverrides: {
      project: {
        textGenerationModelSelection: virtualModelReference(id),
        reviewGuideModelSelection: virtualModelReference(id),
      },
    },
  };
  expect(virtualModelUsage(scoped, id)).toEqual({ agent: true, review: true });
  expect(bindingEditError(scoped, id, "Voice cleanup", "textGenerationModelSelection", t)).toBe(
    "This binding would create an inheritance cycle.",
  );
  expect(
    bindingEditError(settings, id, "Voice cleanup", "textGenerationModelSelection", t),
  ).toBeNull();
  expect(bindingEditError(settings, id, " Default ", null, t)).toBe(
    "This virtual model name is already in use.",
  );
});

describe("settingModelLabel", () => {
  it.each([
    ["defaultModelSelection", "Default virtual model"],
    ["fallbackModelSelection", "Fallback virtual model"],
    ["textGenerationModelSelection", "Text generation virtual model"],
    ["sourceControlWriterModelSelection", "Source control writer virtual model"],
    ["reviewGuideModelSelection", "Review guide virtual model"],
    ["speechPostProcessingModelSelection", "Voice cleanup virtual model"],
  ] satisfies [VirtualModelRole, string][])(
    "labels a direct %s reference without inheriting its binding",
    (role, expected) => {
      expect(settingModelLabel(settings, role, providers, t)).toBe(expected);
    },
  );

  it.each([null, physical, "textGenerationModelSelection"] as const)(
    "keeps a named direct reference when its binding is %j",
    (binding) => {
      const selected = {
        ...settings,
        defaultModelSelection: virtualModelReference("team"),
        virtualModels: { team: { name: "Team", binding } },
      };
      expect(settingModelLabel(selected, "defaultModelSelection", providers, t)).toBe(
        "Team virtual model",
      );
    },
  );

  it.each(["en", "zh-CN"] as const)(
    "distinguishes direct and inherited models in %s without exposing virtual bindings",
    (locale) => {
      const translate = translateUi.bind(null, locale);
      const name = translate("{name} virtual model", { name: "Team" });
      const selected: ServerSettings = {
        ...settings,
        textGenerationModelSelection: virtualModelReference("team"),
        sourceControlWriterModelSelection: null,
        reviewGuideModelSelection: null,
        speechPostProcessingModelSelection: null,
        virtualModels: { team: { name: "Team", binding: physical } },
      };
      expect(
        settingModelLabel(selected, "textGenerationModelSelection", providers, translate),
      ).toBe(name);
      for (const role of [
        "sourceControlWriterModelSelection",
        "reviewGuideModelSelection",
        "speechPostProcessingModelSelection",
      ] as const)
        expect(settingModelLabel(selected, role, providers, translate)).toBe(
          translate("Inherit ({model})", { model: name }),
        );
      expect(
        settingModelLabel(selected, "textGenerationModelSelection", providers, translate, true),
      ).toBe(translate("Inherit ({model})", { model: name }));
      const direct = { ...selected, textGenerationModelSelection: physical };
      expect(settingModelLabel(direct, "textGenerationModelSelection", providers, translate)).toBe(
        "Claude Sonnet",
      );
      expect(settingModelLabel(direct, "reviewGuideModelSelection", providers, translate)).toBe(
        translate("Inherit ({model})", { model: "Claude Sonnet" }),
      );
    },
  );

  it("preserves automatic, no fallback, and missing model names", () => {
    expect(
      settingModelLabel(
        { ...settings, defaultModelSelection: null },
        "defaultModelSelection",
        providers,
        t,
      ),
    ).toBe("Automatic");
    expect(
      settingModelLabel(
        { ...settings, fallbackModelSelection: null },
        "fallbackModelSelection",
        providers,
        t,
      ),
    ).toBe("None");
    expect(
      settingModelLabel(
        { ...settings, defaultModelSelection: { ...physical, model: "missing" } },
        "defaultModelSelection",
        providers,
        t,
      ),
    ).toBe("missing");
  });
});
