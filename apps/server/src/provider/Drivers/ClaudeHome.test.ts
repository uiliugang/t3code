import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { CLAUDE_BYOK_PROTOCOL_VARIABLE, readClaudeByokProtocol } from "@t3tools/shared/claudeByok";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        const byok = yield* makeClaudeEnvironment(
          {
            homePath: "~/.claude-byok-test",
            customModelsOnly: true,
            customModels: ["CaseSensitive"],
          },
          {
            ANTHROPIC_BASE_URL: "https://ba.test",
            ANTHROPIC_AUTH_TOKEN: "byok-key",
            ANTHROPIC_API_KEY: "",
            CLAUDE_CODE_OAUTH_TOKEN: "old",
          },
        );
        const byokConfig = { homePath: "~/.claude-byok-test", customModelsOnly: true };
        const nativeIdentity = yield* makeClaudeContinuationGroupKey(byokConfig, {
          ANTHROPIC_BASE_URL: "https://ba.test",
        });
        const openaiIdentity = yield* makeClaudeContinuationGroupKey(byokConfig, {
          ANTHROPIC_BASE_URL: "https://ba.test",
          T3_CLAUDE_API_FORMAT: "openai",
        });
        expect(openaiIdentity).toBe(`${nativeIdentity}:openai`);
        expect(byok.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
        expect(byok.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("CaseSensitive");
        const invalid = yield* makeClaudeEnvironment(
          { homePath: "~/.claude-byok-test", customModelsOnly: true, customModels: [] },
          {
            ANTHROPIC_BASE_URL: "https://ba.test",
            ANTHROPIC_API_KEY: "one",
            ANTHROPIC_AUTH_TOKEN: "two",
          },
        ).pipe(Effect.flip);
        expect(invalid.reason).toBe("auth");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes t3-code unless overridden",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          [CLAUDE_BYOK_PROTOCOL_VARIABLE]: "openai",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, instance, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        for (const protocol of ["anthropic", "openai"]) {
          const configured = [
            ...instance,
            { name: CLAUDE_BYOK_PROTOCOL_VARIABLE, value: protocol, sensitive: false },
          ];
          expect(
            (yield* mergeClaudeProcessEnvironment({ homePath }, configured, host))[
              CLAUDE_BYOK_PROTOCOL_VARIABLE
            ],
          ).toBe(readClaudeByokProtocol(configured));
        }

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
      }),
  );
});
