import {
  DEFAULT_CLIENT_SETTINGS,
  isManagedSettingPath,
  resolvePromptSuggestionPreference,
} from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useEnvironmentSettingTargets } from "./useEnvironmentSettingTargets";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Switch } from "../ui/switch";

export function PromptSuggestionSettingsRow() {
  const gt = useGT();
  const setting = useSearchableSetting()("prompt-suggestions-beta");
  const { showPredictedMessages } = useScopedSettings();
  const updateDevice = useUpdateScopedSettings();
  const { picker, targets, canWrite, permitted, managedBy, save } = useEnvironmentSettingTargets([
    "promptSuggestionPreference",
  ]);
  const supported =
    targets.length > 0 &&
    targets.every(({ serverConfig }) => serverConfig.promptSuggestionSettings === true);
  const preferences = targets.map(({ serverConfig }) =>
    resolvePromptSuggestionPreference(serverConfig.settings, showPredictedMessages),
  );
  const first = preferences[0];
  const mixedEnabled = preferences.some(({ enabled }) => enabled !== first?.enabled);
  const legacyBothEnabled =
    showPredictedMessages &&
    targets.some(
      ({ serverConfig }) =>
        serverConfig.settings.promptSuggestionPreference === undefined &&
        serverConfig.settings.promptSuggestionsEnabled,
    );
  const mixedSource =
    legacyBothEnabled || preferences.some(({ source }) => source !== first?.source);
  const legacy =
    targets.length > 0 &&
    targets.every(({ serverConfig }) => serverConfig.promptSuggestionSettings !== true);
  const nativeEnabled = targets[0]?.serverConfig.settings.promptSuggestionsEnabled ?? false;
  const nativeMixed = targets.some(
    ({ serverConfig }) => serverConfig.settings.promptSuggestionsEnabled !== nativeEnabled,
  );
  const legacyNativeManaged = targets.find(
    ({ serverConfig }, index) =>
      (!supported || preferences[index]?.source === "native") &&
      isManagedSettingPath(serverConfig.managedPolicy, "promptSuggestionsEnabled"),
  )?.serverConfig.managedPolicy?.organization;
  const label = gt("Suggest next prompt");
  const sourceLabel = gt("Suggestion source");
  const managed =
    managedBy === undefined
      ? undefined
      : gt("Managed by {organization}.", { organization: managedBy });

  return (
    <>
      <SettingsRow
        {...setting}
        description={
          supported
            ? gt(
                "Show a suggestion in the empty composer after a turn. Choose its source for the selected environment.",
              )
            : targets.length > 0
              ? gt("Update the selected environment to choose a single suggestion source.")
              : gt("Connect an environment to choose a suggestion source.")
        }
        managed={managed}
        status={
          targets.length > 0 && !permitted
            ? gt("This connection lacks permission to change settings on the selected environment.")
            : legacyNativeManaged === undefined
              ? undefined
              : gt("Native suggestions are managed by {organization}.", {
                  organization: legacyNativeManaged,
                })
        }
        control={
          <Switch
            aria-label={label}
            checked={
              supported
                ? !mixedEnabled && first?.enabled === true
                : legacy && !nativeMixed && nativeEnabled
            }
            mixed={supported ? mixedEnabled : legacy && nativeMixed}
            disabled={!canWrite || legacyNativeManaged !== undefined || (!supported && !legacy)}
            onCheckedChange={(enabled) =>
              save(() =>
                supported
                  ? {
                      promptSuggestionPreference: {
                        legacyModelEnabled: showPredictedMessages,
                        enabled,
                      },
                    }
                  : { promptSuggestionsEnabled: enabled },
              )
            }
          />
        }
      >
        <div className="flex flex-wrap items-center gap-2 pt-1 pb-2">
          {picker}
          {supported && (
            <ToggleGroup
              aria-label={sourceLabel}
              value={mixedSource || first === undefined ? [] : [first.source]}
              disabled={!canWrite}
              onValueChange={([source]) => {
                if (source !== "native" && source !== "text-generation") return;
                save(() => ({
                  promptSuggestionPreference: {
                    legacyModelEnabled: showPredictedMessages,
                    source,
                  },
                }));
              }}
            >
              <Toggle value="native">{gt("Native suggestions")}</Toggle>
              <Toggle value="text-generation">{gt("Text generation model")}</Toggle>
            </ToggleGroup>
          )}
        </div>
        {supported && (
          <p className="pb-2 text-xs text-muted-foreground">
            {legacyBothEnabled
              ? gt(
                  "This environment is using its previous suggestion preferences. Choose a source to use it exclusively.",
                )
              : mixedSource
                ? gt("The selected environments use different suggestion sources.")
                : first?.source === "native"
                  ? gt(
                      "Native suggestions use an extra cached request on your plan. Requires Codex 0.165 or later.",
                    )
                  : gt(
                      "Model suggestions use your text generation model and count toward its usage.",
                    )}
          </p>
        )}
        {supported && (
          <p className="pb-2 text-xs text-muted-foreground">
            {gt(
              "Restart running Claude sessions after changing suggestion settings. Until restarted, those sessions may still request native suggestions.",
            )}
          </p>
        )}
      </SettingsRow>
      {(!supported ||
        (!permitted &&
          targets.some(
            ({ serverConfig }) => serverConfig.settings.promptSuggestionPreference === undefined,
          ))) && (
        <SettingsRow
          id="composer-predictions"
          title={gt("Show predicted messages")}
          description={gt(
            "Uses your text generation model and counts toward its usage when an environment follows this device's preferences.",
          )}
          resetAction={
            showPredictedMessages !== DEFAULT_CLIENT_SETTINGS.showPredictedMessages ? (
              <SettingResetButton
                label={gt("predicted messages")}
                onClick={() =>
                  updateDevice({
                    showPredictedMessages: DEFAULT_CLIENT_SETTINGS.showPredictedMessages,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              aria-label={gt("Show predicted messages")}
              checked={showPredictedMessages}
              onCheckedChange={(checked) => updateDevice({ showPredictedMessages: checked })}
            />
          }
        />
      )}
    </>
  );
}
