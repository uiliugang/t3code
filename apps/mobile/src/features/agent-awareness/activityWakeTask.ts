import { requireNativeModule } from "expo";
import { AppRegistry, Platform } from "react-native";

if (Platform.OS === "android") {
  AppRegistry.registerHeadlessTask(
    "T3AgentActivityWake",
    () =>
      async ({
        task,
        environmentId,
        userId,
        deviceId,
      }: {
        task: string;
        environmentId: string;
        userId: string;
        deviceId: string;
      }) => {
        const native = requireNativeModule<{
          finishActivityWake(
            task: string,
            card: Record<string, string> | null,
            alerts: Record<string, string>[],
          ): void;
        }>("T3AgentNotifications");
        try {
          const [
            { readNoiseAgentActivity },
            { noiseActivityNotification },
            { loadMessageResolver },
            { loadPreferences },
          ] = await Promise.all([
            import("../../state/agentActivityWake"),
            import("./noiseActivityNotification"),
            import("../../i18n/messages"),
            import("../../persistence/imperative"),
          ]);
          const { runtime } = await import("../../lib/runtime");
          const [{ states, preferences }, resolve] = await Promise.all([
            runtime.runPromise(readNoiseAgentActivity(environmentId, userId, deviceId)),
            loadPreferences().then((stored) =>
              loadMessageResolver(stored.uiLanguage === "zh-CN" ? "zh" : "en"),
            ),
          ]);
          const notification = noiseActivityNotification(
            environmentId,
            states,
            preferences,
            Date.now(),
            resolve,
          );
          native.finishActivityWake(task, notification.card, notification.alerts);
        } catch {
          native.finishActivityWake(task, null, []);
        }
      },
  );
}
