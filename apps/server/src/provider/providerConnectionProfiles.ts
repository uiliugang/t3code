import type {
  ProviderConnectionMode,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { codexConnectionMode, codexRuntimeSource } from "@t3tools/shared/codexByok";
import { isClaudeByok } from "@t3tools/shared/claudeByok";

export function providerConnectionMode(
  instance: Pick<ProviderInstanceConfig, "driver" | "config">,
): ProviderConnectionMode {
  return instance.driver === "codex"
    ? codexConnectionMode(instance.config)
    : isClaudeByok(instance.config)
      ? "byok"
      : "existing";
}

export function switchProviderConnection(
  instance: ProviderInstanceConfig,
  instanceId: ProviderInstanceId,
  mode: ProviderConnectionMode,
): ProviderInstanceConfig {
  const current = providerConnectionMode(instance);
  if (current === mode) return instance;
  const config = instance.config && typeof instance.config === "object" ? instance.config : {};
  const profiles = { ...instance.connectionProfiles };
  const target = profiles[mode];
  delete profiles[mode];
  // Moving a materialized secret to a different slot must write its value there.
  const environment = (values: ProviderInstanceConfig["environment"]) =>
    (values ?? []).map(({ valueRedacted: _redacted, ...entry }) => entry);
  profiles[current] = { config: instance.config, environment: environment(instance.environment) };
  const defaults =
    instance.driver === "codex"
      ? {
          connectionMode: mode,
          setupMode: mode === "chatgpt" ? "managed" : "existing",
          runtimeSource: codexRuntimeSource(config),
          ...("binaryPath" in config ? { binaryPath: config.binaryPath } : {}),
        }
      : {
          customModelsOnly: mode === "byok",
          ...("setupMode" in config ? { setupMode: config.setupMode } : {}),
          ...("binaryPath" in config ? { binaryPath: config.binaryPath } : {}),
          ...(mode === "byok" ? { homePath: `~/.claude-t3/${instanceId}/byok` } : {}),
        };
  const restored = target ? (target.config ?? {}) : defaults;
  return {
    ...instance,
    config:
      instance.driver === "codex"
        ? {
            ...(restored as object),
            runtimeSource: codexRuntimeSource(restored),
            connectionMode: mode,
            setupMode: mode === "chatgpt" ? "managed" : "existing",
          }
        : restored,
    environment: environment(target?.environment),
    connectionProfiles: profiles,
  };
}

export function providerConnectionConfigurations(
  instance: ProviderInstanceConfig,
): ProviderInstanceConfig[] {
  const { connectionProfiles, ...active } = instance;
  return [
    active,
    ...Object.values(connectionProfiles ?? {}).map((profile) => ({
      ...active,
      config: profile.config,
      environment: profile.environment ?? [],
    })),
  ];
}
