import type { ClaudeSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readCustomModelEntries } from "@t3tools/shared/model";
import {
  CLAUDE_BYOK_PROTOCOL_VARIABLE,
  claudeByokUrlError,
  normalizeClaudeByokBaseUrl,
} from "@t3tools/shared/claudeByok";

import { readClaudeSettingsEnv } from "./ClaudeSkills.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const CLAUDE_BYOK_ENVIRONMENT_OVERRIDES = {
  CLAUDE_CODE_OAUTH_TOKEN: "",
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  CLAUDE_CODE_USE_BEDROCK: "0",
  CLAUDE_CODE_USE_VERTEX: "0",
  CLAUDE_CODE_USE_FOUNDRY: "0",
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

export class ClaudeEnvironmentError extends Schema.TaggedError<
  ClaudeEnvironmentError,
  { readonly brand: unique symbol }
>()("ClaudeEnvironmentError", { reason: Schema.Literals(["auth", "endpoint", "models", "home"]) }) {
  override get message() {
    return {
      auth: "Configure exactly one Claude BYOK credential.",
      endpoint: "Configure a valid Claude BYOK base URL.",
      models: "Configure at least one Claude BYOK model.",
      home: "Configure an isolated Claude BYOK home directory.",
    }[this.reason];
  }
}

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath"> &
    Partial<Pick<ClaudeSettings, "customModelsOnly" | "customModels">>,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, ClaudeEnvironmentError, Path.Path> {
  const resolvedBaseEnv = { ...(baseEnv ?? process.env) };
  if (config.customModelsOnly) {
    const token = resolvedBaseEnv.ANTHROPIC_AUTH_TOKEN?.trim();
    const key = resolvedBaseEnv.ANTHROPIC_API_KEY?.trim();
    if (Boolean(token) === Boolean(key)) {
      return yield* new ClaudeEnvironmentError({ reason: "auth" });
    }
    if (claudeByokUrlError(resolvedBaseEnv.ANTHROPIC_BASE_URL?.trim() ?? ""))
      return yield* new ClaudeEnvironmentError({ reason: "endpoint" });
    resolvedBaseEnv.ANTHROPIC_BASE_URL = normalizeClaudeByokBaseUrl(
      resolvedBaseEnv.ANTHROPIC_BASE_URL!,
    );
    if (!config.homePath.trim()) return yield* new ClaudeEnvironmentError({ reason: "home" });
    Object.assign(resolvedBaseEnv, CLAUDE_BYOK_ENVIRONMENT_OVERRIDES);
    resolvedBaseEnv.ANTHROPIC_AUTH_TOKEN = token ?? "";
    resolvedBaseEnv.ANTHROPIC_API_KEY = key ?? "";
    const model = readCustomModelEntries(config.customModels ?? [])[0]?.slug;
    if (!model) return yield* new ClaudeEnvironmentError({ reason: "models" });
    if (model) {
      for (const variable of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
      ])
        resolvedBaseEnv[variable] = model;
    }
  }
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

// A Claude Code session that launched T3 exports these. A claude spawned with them acts as part of
// that session: its session id, messaging socket and token, and effort.
const CLAUDE_HOST_SESSION_VARIABLES = [
  CLAUDE_BYOK_PROTOCOL_VARIABLE,
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];

/**
 * Base env for the Claude processes T3 Code runs, before `makeClaudeEnvironment`.
 * Claude Code reads its entrypoint from the process env, not its settings `env`, so T3 Code applies that override itself.
 */
export const mergeClaudeProcessEnvironment = Effect.fn("mergeClaudeProcessEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...hostEnvironment,
    CLAUDE_CODE_ENTRYPOINT: "t3-code",
  };
  for (const name of CLAUDE_HOST_SESSION_VARIABLES) delete baseEnvironment[name];
  // The desktop runs the server as Node through Electron. Commands Claude runs inherit its env, so
  // an Electron app they start (T3 Code itself, VS Code) would run as Node and exit.
  delete baseEnvironment.ELECTRON_RUN_AS_NODE;
  const environment = yield* mergeProviderInstanceEnvironment(instanceEnvironment, baseEnvironment);
  const settingsEntrypoint = (yield* readClaudeSettingsEnv(config, undefined, environment))
    .CLAUDE_CODE_ENTRYPOINT;
  return settingsEntrypoint
    ? { ...environment, CLAUDE_CODE_ENTRYPOINT: settingsEntrypoint }
    : environment;
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "customModelsOnly">>,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}${config.customModelsOnly ? `:byok:${environment?.ANTHROPIC_BASE_URL?.trim() ?? ""}${environment?.T3_CLAUDE_API_FORMAT === "openai" ? ":openai" : ""}` : ""}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
