import { expect, it } from "vite-plus/test";

import {
  decodeMobileTransferPreferences,
  exportMobileTransferPreferences,
  mobileClientSettingsForExport,
  mobilePreferencesFromClientSettings,
} from "./mobileSettingsTransfer.logic";

it("transfers presentation preferences without including device state", () => {
  const preferences = {
    showRepositoryIcons: false,
    showGroupIcons: false,
    capitalizeProjectNames: false,
    uiLanguage: "zh-CN" as const,
    mathRenderingEnabled: true,
    showPredictedMessages: true,
    toolCallVisibility: "hideSuccessful" as const,
    branchIssuesVisible: false,
    branchIssuesExpanded: true,
    branchIssuesShowEmpty: false,
    branchIssuesSeparate: true,
  };
  const devicePreferences = {
    ...preferences,
    planModeEnabled: true,
    collapsedProjectGroups: ["local-group"],
    lastThreadProject: { projectId: "local-project", environmentId: "local-environment" },
    connectOnboardingOptOutAccounts: ["local-account"],
    microphones: [{ kind: "wired" as const, uid: "local-microphone", name: "Local microphone" }],
  };
  const exported = exportMobileTransferPreferences(devicePreferences);
  expect(exported).toEqual(preferences);
  expect(decodeMobileTransferPreferences(JSON.parse(JSON.stringify(exported)))).toEqual(
    preferences,
  );
  expect(decodeMobileTransferPreferences({})).toEqual({});
  expect(() => decodeMobileTransferPreferences({ showRepositoryIcons: "false" })).toThrow();
  const common = mobileClientSettingsForExport({
    ...devicePreferences,
    workingShelfEnabled: false,
    projectGroupingMode: "separate",
    modelFavorites: [],
  });
  expect(common).toEqual({
    showRepositoryIcons: false,
    showGroupIcons: false,
    capitalizeProjectNames: false,
    uiLanguage: "zh-CN",
    mathRenderingEnabled: true,
    showPredictedMessages: true,
    toolCallVisibility: "hideSuccessful",
    branchIssuesExpanded: true,
    branchIssuesShowEmpty: false,
    branchIssuesPlacement: "separate",
    sidebarWorkingShelfEnabled: false,
    sidebarProjectGroupingMode: "separate",
    favorites: [],
  });
  expect(
    mobilePreferencesFromClientSettings({
      ...common,
      threadDetailsItems: { issues: false, changes: false },
    }),
  ).toEqual({
    ...preferences,
    workingShelfEnabled: false,
    projectGroupingMode: "separate",
    projectGroupingEnabled: false,
    modelFavorites: [],
  });
  expect(mobilePreferencesFromClientSettings({})).toEqual({});
});
