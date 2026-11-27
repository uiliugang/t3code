// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

/**
 * Returns an effect reading the real path of the installed Claude binary.
 * Updates repoint the installed link to a new version file, so comparing this
 * detects when a live CLI process was started from an older version.
 */
export const claudeProgramReader = Effect.fn("claudeProgramReader")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<Effect.Effect<string | undefined>> {
  const platform = yield* HostProcess.Platform;
  const resolveExecutable = yield* SpawnExecutableResolution;
  return Effect.promise(async () => {
    try {
      const resolved = await resolveExecutable(binaryPath, platform, environment);
      return resolved === undefined ? undefined : await NodeFS.promises.realpath(resolved);
    } catch {
      return undefined;
    }
  });
});

/**
 * Reports whether an update replaced the program a live CLI process started
 * from. An unreadable path on either side reports no update.
 */
export const claudeProgramWasReplaced = (
  startedFrom: string | undefined,
  now: string | undefined,
): boolean => startedFrom !== undefined && now !== undefined && startedFrom !== now;
