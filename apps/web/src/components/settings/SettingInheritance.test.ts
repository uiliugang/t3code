import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { translateUi } from "@t3tools/shared/uiLocale";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

describe("worktree cleanup inheritance", () => {
  it("distinguishes project and environment worktree cleanup policies", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      worktreeCleanup: {
        mode: "custom" as const,
        rules: DEFAULT_SERVER_SETTINGS.storageCleanup,
      },
      projectSettingsOverrides: {
        [projectId]: { worktreeCleanup: { mode: "off" as const } },
      },
    };
    const layers = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(settings, projectId),
      },
      settings,
      "worktreeCleanup",
    );
    expect(layers.map((layer) => [layer.key, layer.value, layer.effective])).toEqual([
      ["project", "Off", true],
      ["environment", "Custom", false],
      ["built-in", "Not set", false],
    ]);
  });
});

describe("settingInheritanceLayers", () => {
  it("identifies the background activity profile supplied by each layer", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1 as const,
        profile: "performance" as const,
        overrides: {},
      },
    };
    const layers = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId: null,
        ...resolveProjectSettings(settings, projectId),
      },
      settings,
      "backgroundActivity",
    );
    expect(layers.map((layer) => [layer.key, layer.value, layer.effective])).toEqual([
      ["environment", "Performance", true],
      ["built-in", "Balanced", false],
    ]);
  });

  it("shows the checkout's t3.json as a layer for file-backed keys", () => {
    const inheritedSettings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: null };
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromFile = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(inheritedSettings, projectId, null, file),
      },
      inheritedSettings,
      "defaultThreadEnvMode",
    );
    expect(fromFile.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
      ["Project", "Inherits", false],
      ["Laptop", "Inherits", false],
      ["t3.json", "New worktree", true],
      ["Default", "Current checkout", false],
    ]);
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" as const };
    const fromEnvironment = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(settings, projectId, null, file),
      },
      settings,
      "defaultThreadEnvMode",
    );
    expect(fromEnvironment.map((layer) => [layer.value, layer.effective])).toEqual([
      ["Inherits", false],
      ["Current checkout", true],
      ["Inherits", false],
      ["Current checkout", false],
    ]);
    const fromDefaults = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file),
      },
      DEFAULT_SERVER_SETTINGS,
      "defaultThreadEnvMode",
      translateUi.bind(null, "zh-CN"),
    );
    expect(fromDefaults.map((layer) => [layer.value, layer.effective])).toEqual([
      ["继承", false],
      ["新建工作树", true],
      ["继承", false],
      ["当前检出", false],
    ]);
  });

  it("localizes values without translating model IDs", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      sidebarAutoSettleAfterDays: 2,
      idleCompaction: "onReturn" as const,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "Default" },
    };
    const target = {
      environmentId,
      label: "Default",
      projectId,
      ...resolveProjectSettings(settings, projectId),
    };
    const t = translateUi.bind(null, "zh-CN");
    expect(
      settingInheritanceLayers(target, settings, "idleCompaction", t).find(
        (layer) => layer.key === "environment",
      )?.value,
    ).toBe("返回时");
    expect(
      settingInheritanceLayers(target, settings, "sidebarAutoSettleAfterDays", t)[1]?.value,
    ).toBe("2 天");
    expect(settingInheritanceLayers(target, settings, "defaultModelSelection", t)[1]?.value).toBe(
      "Default",
    );
    expect(settingInheritanceLayers(target, settings, "defaultModelSelection", t)[1]?.label).toBe(
      "Default",
    );
  });
});
