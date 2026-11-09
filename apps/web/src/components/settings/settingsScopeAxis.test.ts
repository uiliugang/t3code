import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  selectEnvironmentAxis,
  selectProjectAxis,
  selectSingleEnvironmentScope,
  SINGLE_ENVIRONMENT_SETTINGS_PATHS,
} from "./settingsScopeAxis";

describe("settings scope axes", () => {
  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });

  it("defaults skill management to the local environment while preserving explicit selections", () => {
    const localId = EnvironmentId.make("local");
    const remoteId = EnvironmentId.make("remote");
    const environments = [
      { environmentId: remoteId, label: "Remote", connection: { phase: "connected" as const } },
      { environmentId: localId, label: "Local", connection: { phase: "connected" as const } },
    ];
    for (const [search, primaryId, expected] of [
      [{}, localId, { machine: localId }],
      [{ machine: remoteId }, localId, { machine: remoteId }],
      [{}, null, { machine: remoteId }],
      [{ machine: "removed" }, localId, { machine: "removed" }],
    ] satisfies readonly [SettingsScopeSearch, EnvironmentId | null, SettingsScopeSearch][]) {
      const selected = SINGLE_ENVIRONMENT_SETTINGS_PATHS.has("/settings/skills")
        ? selectSingleEnvironmentScope(
            search,
            resolveSettingsScope(search, [], environments),
            environments,
            primaryId,
          )
        : search;
      expect(selected).toEqual(expected);
    }
  });
});
