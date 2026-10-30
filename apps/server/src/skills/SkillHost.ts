import { ProviderInstanceId, SkillManagerError, type SkillTarget } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";

export class SkillHost extends Context.Service<
  SkillHost,
  {
    readonly targets: Effect.Effect<ReadonlyArray<SkillTarget>, SkillManagerError>;
    readonly discovered: Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly path: string; readonly provider: string }>
    >;
    readonly busy: Effect.Effect<boolean, SkillManagerError>;
    readonly refresh: (targets: ReadonlyArray<SkillTarget>) => Effect.Effect<void>;
  }
>()("t3/skills/SkillHost") {}

const decodeHome = Schema.decodeUnknownEffect(
  Schema.Struct({ homePath: Schema.optionalKey(Schema.String) }),
);
const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const targets = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const result: SkillTarget[] = [];
    for (const [id, instance] of Object.entries(deriveProviderInstanceConfigMap(current))) {
      const config = yield* decodeHome(instance.config ?? {}).pipe(
        Effect.orElseSucceed(() => ({}) as { homePath?: string }),
      );
      const env = {
        ...environment,
        ...Object.fromEntries(
          (instance.environment ?? [])
            .filter((entry) => !entry.valueRedacted)
            .map((entry) => [entry.name, entry.value]),
        ),
      };
      const userHome = env.HOME || env.USERPROFILE || home;
      const configuredHome = config.homePath?.trim()
        ? expandHomePath(config.homePath, home)
        : undefined;
      let directory: string | undefined;
      switch (instance.driver) {
        case "codex":
          directory = path.join(
            configuredHome || env.CODEX_HOME || path.join(userHome, ".codex"),
            "skills",
          );
          break;
        case "claudeAgent":
          directory = path.join(
            configuredHome || env.CLAUDE_CONFIG_DIR || path.join(userHome, ".claude"),
            "skills",
          );
          break;
        case "cursor":
          directory = path.join(userHome, ".cursor", "skills");
          break;
        case "grok":
          directory = path.join(env.GROK_HOME || path.join(userHome, ".grok"), "skills");
          break;
        case "opencode":
          directory = path.join(
            env.XDG_CONFIG_HOME || path.join(userHome, ".config"),
            "opencode",
            "skills",
          );
          break;
        case "antigravity":
          directory = path.join(userHome, ".gemini", "antigravity", "skills");
          break;
      }
      if (directory)
        result.push({
          id,
          label: instance.displayName || id,
          directory: path.resolve(directory),
          providerInstanceId: ProviderInstanceId.make(id),
        });
    }
    result.push({
      id: "directory:codebuddy",
      label: "CodeBuddy",
      directory: path.join(home, ".codebuddy", "skills"),
    });
    return result;
  }).pipe(
    Effect.mapError(
      (cause) => new SkillManagerError({ operation: "targets", reason: "io", cause }),
    ),
  );
  const busy = sql<{
    count: number;
  }>`SELECT count(*) AS count FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'starting', 'running', 'waiting')`.pipe(
    Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
    Effect.mapError((cause) => new SkillManagerError({ operation: "busy", reason: "io", cause })),
  );
  const refresh = Effect.fn("SkillHost.refresh")(function* (bound: ReadonlyArray<SkillTarget>) {
    const ids = [
      ...new Set(
        bound.flatMap((target) => (target.providerInstanceId ? [target.providerInstanceId] : [])),
      ),
    ];
    yield* Effect.forEach(ids, (id) => providers.refreshInstance(id), { discard: true });
  });
  const discovered = providers.getProviders.pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) =>
        entry.skills.map((skill) => ({
          name: skill.name,
          path: skill.path,
          provider: entry.instanceId,
        })),
      ),
    ),
  );
  return SkillHost.of({ targets, busy, refresh, discovered });
});
export const layer = Layer.effect(SkillHost, make);
