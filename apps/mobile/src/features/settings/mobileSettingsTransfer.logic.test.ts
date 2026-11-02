import { expect, it } from "vite-plus/test";

import {
  decodeMobileTransferPreferences,
  exportMobileTransferPreferences,
} from "./mobileSettingsTransfer.logic";

it("transfers presentation preferences without including device state", () => {
  const preferences = {
    showRepositoryIcons: false,
    showGroupIcons: false,
    capitalizeProjectNames: false,
    uiLanguage: "zh-CN" as const,
    mathRenderingEnabled: true,
    showPredictedMessages: true,
  };
  const devicePreferences = {
    ...preferences,
    collapsedProjectGroups: ["local-group"],
    lastThreadProject: { projectId: "local-project", environmentId: "local-environment" },
    connectOnboardingOptOutAccounts: ["local-account"],
    microphones: [{ id: "local-microphone" }],
  };
  const exported = exportMobileTransferPreferences(devicePreferences);
  expect(exported).toEqual(preferences);
  expect(decodeMobileTransferPreferences(JSON.parse(JSON.stringify(exported)))).toEqual(
    preferences,
  );
  expect(decodeMobileTransferPreferences({})).toEqual({});
  expect(() => decodeMobileTransferPreferences({ showRepositoryIcons: "false" })).toThrow();
});
