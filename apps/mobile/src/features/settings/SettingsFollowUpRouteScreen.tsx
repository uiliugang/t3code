import { msg, useGT, useMessages } from "gt-react-native";
import { resolvePromptSuggestionPreference } from "@t3tools/client-runtime/composer-prediction";
import {
  AuthSettingsWriteScope,
  isManagedSettingPath,
  type PromptSuggestionPreference,
} from "@t3tools/contracts";
import { useState } from "react";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { DEFAULT_FOLLOW_UP_BEHAVIOR, type FollowUpBehavior } from "../../lib/followUpBehavior";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { SettingsScreen } from "./components/SettingsScreen";

const FOLLOW_UP_OPTIONS: ReadonlyArray<{
  readonly behavior: FollowUpBehavior;
  readonly label: string;
  readonly description: string;
}> = [
  {
    behavior: "queue",
    label: msg("Queue", { $context: "verb, follow-up behavior" }),
    description: msg("Your message waits and runs after the current turn finishes."),
  },
  {
    behavior: "steer",
    label: msg("Steer", { $context: "verb, follow-up behavior" }),
    description: msg("Your message reaches the agent right away, changing what it is working on."),
  },
];

export function SettingsFollowUpRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const t = useUiTranslation();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : null;

  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <PromptSuggestionSettingsSections />
      <SettingsSection title={gt("While the agent is running")}>
        {FOLLOW_UP_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option.behavior}
            label={m(option.label)}
            description={m(option.description)}
            selected={selectedBehavior === option.behavior}
            separated={index > 0}
            disabled={!preferencesReady}
            onPress={() => {
              void savePreferences({ followUpBehavior: option.behavior });
            }}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {t(
          "Long-press the send button to use the other option for a single message. With a hardware keyboard, hold {key} while sending.",
          { key: Platform.OS === "android" ? "Ctrl" : "Command" },
        )}
      </Text>
    </ScrollView>
  );

  return <SettingsScreen title={t("Chat")}>{content}</SettingsScreen>;
}

function PromptSuggestionSettingsSections() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const showPredictedMessages = ready && preferences.value.showPredictedMessages === true;
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const supported = connected.filter(
    ({ serverConfig }) => serverConfig?.promptSuggestionSettings === true,
  );

  return (
    <>
      {supported.map((environment) => (
        <PromptSuggestionEnvironmentSection
          key={environment.environmentId}
          environment={environment}
          showEnvironment={connected.length > 1}
          showPredictedMessages={showPredictedMessages}
          preferencesReady={ready}
        />
      ))}
      {(supported.length === 0 || supported.length !== connected.length) && (
        <SettingsSection title={gt("Composer")}>
          <ListToggleRow
            label={gt("Show predicted messages")}
            description={gt(
              "Uses the text generation model and counts toward its usage on older environments.",
            )}
            disabled={!ready}
            value={showPredictedMessages}
            onValueChange={(value) => save({ showPredictedMessages: value })}
          />
        </SettingsSection>
      )}
    </>
  );
}

function PromptSuggestionEnvironmentSection({
  environment,
  showEnvironment,
  showPredictedMessages,
  preferencesReady,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironment: boolean;
  readonly showPredictedMessages: boolean;
  readonly preferencesReady: boolean;
}) {
  const gt = useGT();
  const { environmentId, label, serverConfig } = environment;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [saving, setSaving] = useState(false);
  if (!serverConfig) return null;
  const { settings, managedPolicy } = serverConfig;
  const managed =
    isManagedSettingPath(managedPolicy, "promptSuggestionsEnabled") ||
    isManagedSettingPath(managedPolicy, "promptSuggestionPreference");
  const disabled =
    managed || !canWrite || saving || (!settings.promptSuggestionPreference && !preferencesReady);
  const preference = resolvePromptSuggestionPreference(settings, showPredictedMessages);

  const save = (change: Partial<PromptSuggestionPreference>) => {
    if (disabled) return;
    setSaving(true);
    void update({
      environmentId,
      input: { patch: { promptSuggestionPreference: { ...preference, ...change } } },
    }).finally(() => setSaving(false));
  };

  return (
    <SettingsSection title={showEnvironment ? gt("Composer · {label}", { label }) : gt("Composer")}>
      <ListToggleRow
        label={gt("Suggest next prompt")}
        description={
          managed
            ? gt("Managed by {organization}.", { organization: managedPolicy?.organization ?? "" })
            : gt("Show a suggestion in the empty composer after a turn.")
        }
        disabled={disabled}
        value={preference.enabled}
        onValueChange={(enabled) => save({ enabled })}
      />
      <SettingsChoiceRow
        label={gt("Native suggestions")}
        description={gt(
          "Native suggestions use an extra cached request on your plan. Requires Codex 0.165 or later. Restart Claude sessions to apply changes.",
        )}
        selected={preference.source === "native"}
        disabled={disabled}
        separated
        onPress={() => save({ source: "native" })}
      />
      <SettingsChoiceRow
        label={gt("Text generation model")}
        description={gt(
          "Model suggestions use your text generation model and count toward its usage.",
        )}
        selected={preference.source === "text-generation"}
        disabled={disabled}
        separated
        onPress={() => save({ source: "text-generation" })}
      />
    </SettingsSection>
  );
}
