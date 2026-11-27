import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import { SshPasswordPromptError } from "./errors.ts";

export interface SshPasswordRequest {
  readonly destination: string;
  readonly username: string | null;
  readonly prompt: string;
  readonly attempt: number;
}

export interface SshAuthOptions {
  readonly authSecret?: string | null;
  readonly batchMode?: "yes" | "no";
  readonly interactiveAuth?: boolean;
  readonly passwordDestination?: string;
}

export interface SshPasswordPromptShape {
  readonly isAvailable: boolean;
  readonly request: (
    request: SshPasswordRequest,
  ) => Effect.Effect<string | null, SshPasswordPromptError>;
}

export class SshPasswordPrompt extends Context.Service<SshPasswordPrompt, SshPasswordPromptShape>()(
  "@t3tools/ssh/auth/SshPasswordPrompt",
) {
  static readonly disabledLayer = Layer.succeed(
    SshPasswordPrompt,
    SshPasswordPrompt.of({
      isAvailable: false,
      request: Effect.fn("SshPasswordPrompt.request")(function () {
        return Effect.succeed(null);
      }),
    }),
  );
}

export interface SshChildEnvironmentOptions {
  readonly interactiveAuth?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly askpassDirectory?: string;
  readonly authSecret?: string | null;
}

const SSH_ASKPASS_DIR_NAME = "t3code-ssh-askpass";

const ASKPASS_POSIX_SCRIPT = `#!/bin/sh
# Invoked by ssh via SSH_ASKPASS when T3 Code re-runs ssh with a cached password
# from the renderer's in-app prompt. We never expose a native dialog here - if
# T3_SSH_AUTH_SECRET is missing, that's a caller bug and we fail loudly.
if [ "\${T3_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\\n" "$T3_SSH_AUTH_SECRET"
  exit 0
fi
printf 'T3 Code ssh-askpass invoked without T3_SSH_AUTH_SECRET.\\n' >&2
exit 1
`;

const ensureSshAskpassHelpers = Effect.fn("ssh/auth.ensureSshAskpassHelpers")(function* (input: {
  readonly directory: string;
}): Effect.fn.Return<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const helperPath = path.join(input.directory, "ssh-askpass.sh");
  yield* fs.makeDirectory(input.directory, { recursive: true });

  const exists = yield* fs.exists(helperPath);
  const current = exists ? yield* fs.readFileString(helperPath) : null;
  if (current !== ASKPASS_POSIX_SCRIPT) {
    yield* fs.writeFileString(helperPath, ASKPASS_POSIX_SCRIPT);
  }
  yield* fs.chmod(helperPath, 0o700);
  return helperPath;
});

// Keep setup serialized through cancellation so writes finish before another command uses the helper.
let defaultSshAskpassRuntimeDirectory: string | undefined;
const defaultSshAskpassLock = Semaphore.makeUnsafe(1);

const ensureDefaultSshAskpassHelpers = Effect.fn("ssh/auth.ensureDefaultSshAskpassHelpers")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userId = yield* HostProcess.UserId;
    let runtimeDirectory = defaultSshAskpassRuntimeDirectory;
    if (runtimeDirectory !== undefined) {
      const cached = runtimeDirectory;
      const reusable = yield* Effect.all([fs.realPath(cached), fs.stat(cached)]).pipe(
        Effect.map(
          ([resolved, info]) =>
            resolved === cached &&
            info.type === "Directory" &&
            (userId === undefined || Option.getOrUndefined(info.uid) === userId),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!reusable) {
        runtimeDirectory = undefined;
      }
    }
    runtimeDirectory ??= yield* fs.realPath(
      yield* fs.makeTempDirectory({ prefix: "t3code-ssh-runtime-" }),
    );
    const helperPath = yield* ensureSshAskpassHelpers({
      directory: path.join(runtimeDirectory, SSH_ASKPASS_DIR_NAME),
    });
    defaultSshAskpassRuntimeDirectory = runtimeDirectory;
    return helperPath;
  },
  (effect) => defaultSshAskpassLock.withPermit(Effect.uninterruptible(effect)),
);

export const buildSshChildEnvironment = Effect.fn("ssh/auth.buildSshChildEnvironment")(function* (
  input: SshChildEnvironmentOptions = {},
): Effect.fn.Return<
  NodeJS.ProcessEnv,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const baseEnv = { ...input.baseEnv };
  if (!input.interactiveAuth) {
    return baseEnv;
  }

  const hostDisplay = input.baseEnv
    ? input.baseEnv.DISPLAY
    : yield* Config.String("DISPLAY").pipe(
        Config.option,
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.map(Option.getOrUndefined),
      );
  const helperPath =
    input.askpassDirectory === undefined
      ? yield* ensureDefaultSshAskpassHelpers()
      : yield* ensureSshAskpassHelpers({ directory: input.askpassDirectory });

  const authSecretEnv =
    input.authSecret === undefined ? {} : { T3_SSH_AUTH_SECRET: input.authSecret ?? "" };

  return {
    ...baseEnv,
    SSH_ASKPASS: helperPath,
    SSH_ASKPASS_REQUIRE: "force",
    ...authSecretEnv,
    ...(baseEnv.DISPLAY || hostDisplay ? {} : { DISPLAY: "t3code" }),
  };
});

export function isSshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)/u.test(
      normalized,
    ) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  );
}

// A local agent signing failure cannot be remedied by the remote account password.
export function isSshAgentSigningFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sign_and_send_pubkey: signing failed(?: for [^\n]* from agent:|: (?:agent refused operation|communication with agent failed))/u.test(
    message,
  );
}
