import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SkillHost from "./SkillHost.ts";

it.effect("includes default providers and respects per-account skill homes", () =>
  Effect.gen(function* () {
    const host = yield* SkillHost.SkillHost;
    const targets = yield* host.targets;
    expect(targets.find((entry) => entry.id === "codex")?.directory).toBe("/fixture/.codex/skills");
    expect(targets.find((entry) => entry.id === "claudeAgent")?.directory).toBe(
      "/fixture/.claude/skills",
    );
    expect(targets.find((entry) => entry.id === "work")?.directory).toBe(
      "/fixture/.codex-work/skills",
    );
    expect(targets.find((entry) => entry.id === "claude-work")?.directory).toBe(
      "/fixture/claude-work/skills",
    );
    expect(targets.find((entry) => entry.id === "secret-home")?.directory).toBe(
      "/fixture/secret-home/skills",
    );
  }).pipe(
    Effect.provide(
      SkillHost.layer.pipe(
        Layer.provide(
          Layer.mock(SecretResolver.SecretResolver)({
            read: () => Effect.succeed(["/fixture/secret-home"]),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              providerInstances: {
                work: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: "~/.codex-work" },
                },
                "claude-work": {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/fixture/claude-work" }],
                },
                "secret-home": {
                  driver: ProviderDriverKind.make("codex"),
                  environment: [
                    {
                      name: "CODEX_HOME",
                      value: {
                        provider: SecretProviderId.make("vault"),
                        reference: "op://vault/agent/home",
                      },
                    },
                  ],
                },
              },
            }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        ),
        Layer.provide(Sqlite.layerMemory),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/fixture")),
        Layer.provide(Layer.succeed(HostProcess.Environment, {})),
      ),
    ),
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);
