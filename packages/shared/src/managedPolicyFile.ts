import { ManagedPolicyDocument, SERVER_EXIT_CODE_MANAGED_POLICY } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ManagedPolicyFileError extends Schema.TaggedError<
  ManagedPolicyFileError,
  { readonly brand: unique symbol }
>()("ManagedPolicyFileError", {
  path: Schema.String,
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_MANAGED_POLICY;

  override get message(): string {
    return `T3 Code cannot use the managed policy at ${this.path}: ${this.reason}. It will not start until an administrator fixes this.`;
  }
}

/** The system path an administrator deploys the policy to on `platform`. */
export function managedPolicyPath(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/T3Code/policy.json";
    default:
      return "/etc/t3code/policy.json";
  }
}

// Unknown keys may be restrictions from a newer release; refusing them keeps a file this
// build cannot fully enforce from looking enforced.
const decodeDocumentJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(ManagedPolicyDocument),
  { onExcessProperty: "error" },
);
const decodeDocumentExit = Schema.decodeUnknownExit(ManagedPolicyDocument, {
  onExcessProperty: "error",
});

/** Decode a policy from JSON text, or from a value a profile already parsed. */
const decodeDocument = (path: string, raw: unknown) => {
  const decoded = typeof raw === "string" ? decodeDocumentJsonExit(raw) : decodeDocumentExit(raw);
  if (Exit.isSuccess(decoded)) return Effect.succeed(decoded.value);
  const error = Cause.squash(decoded.cause);
  // The schema message names the offending key, e.g. `Expected no excess property at ["limits"]`.
  const detail = Schema.isSchemaError(error) ? ` (${error.message.replace(/\s*\n\s*/g, " ")})` : "";
  return Effect.fail(
    new ManagedPolicyFileError({
      path,
      reason: `it is not valid JSON or does not match the policy schema${detail}`,
      cause: decoded.cause,
    }),
  );
};

/** Read the policy document at `path`; a missing file means no policy. */
export const readManagedPolicyFile = Effect.fn("readManagedPolicyFile")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(path)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ManagedPolicyFileError({ path, reason: "the file cannot be checked", cause }),
      ),
    );
  if (!exists) return undefined;
  const raw = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (cause) => new ManagedPolicyFileError({ path, reason: "the file cannot be read", cause }),
      ),
    );
  return yield* decodeDocument(path, raw);
});

/** Where a configuration profile's managed preferences land on macOS. */
export const MACOS_MANAGED_PREFERENCES_PATH =
  "/Library/Managed Preferences/com.t3tools.t3code.plist";
// An absolute path: an earlier PATH entry could otherwise answer that there is no policy.
const PLUTIL = "/usr/bin/plutil";

const run = Effect.fnUntraced(
  function* (command: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
      { concurrency: 2 },
    );
    return { stdout, exitCode: Number(exitCode) };
  },
  Effect.scoped,
  Effect.timeout(Duration.seconds(10)),
);

const decodeJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
// Strict: keys beside the wrapper, or more than one entry, decode as a plain document and fail.
const decodeForcedExit = Schema.decodeUnknownExit(
  Schema.Struct({
    Forced: Schema.Tuple([Schema.Struct({ mcx_preference_settings: Schema.Unknown })]),
  }),
  { onExcessProperty: "error" },
);

// macOS writes `PayloadUUID` and `_manualProfile` beside the profile's own keys; no policy key
// starts with `Payload` or `_`, so dropping them cannot hide a restriction.
const withoutProfileKeys = (value: unknown) =>
  value === null || typeof value !== "object" || Array.isArray(value)
    ? value
    : Object.fromEntries(
        Object.entries(value).filter(([key]) => !key.startsWith("Payload") && !key.startsWith("_")),
      );

/**
 * Installed managed preferences hold the profile's keys directly, but MCX-style profiles keep
 * them under `Forced[0].mcx_preference_settings`; read either rather than refuse a valid profile.
 */
function unwrapForced(json: string): unknown {
  const parsed = decodeJsonExit(json);
  if (Exit.isFailure(parsed)) return json;
  const preferences = withoutProfileKeys(parsed.value);
  const forced = decodeForcedExit(preferences);
  return Exit.isSuccess(forced)
    ? withoutProfileKeys(forced.value.Forced[0].mcx_preference_settings)
    : preferences;
}

/** Read the policy a configuration profile set; absent means no such policy. */
const readPlatformPolicy = Effect.fnUntraced(function* (platform: NodeJS.Platform) {
  if (platform === "darwin") {
    const path = MACOS_MANAGED_PREFERENCES_PATH;
    const exists = yield* (yield* FileSystem.FileSystem)
      .exists(path)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ManagedPolicyFileError({ path, reason: "the profile cannot be checked", cause }),
        ),
      );
    if (!exists) return undefined;
    const converted = yield* run(PLUTIL, ["-convert", "json", "-o", "-", path]).pipe(
      Effect.mapError(
        (cause) =>
          new ManagedPolicyFileError({ path, reason: "the profile cannot be read", cause }),
      ),
    );
    if (converted.exitCode !== 0) {
      return yield* new ManagedPolicyFileError({ path, reason: "the profile cannot be read" });
    }
    return { source: path, document: yield* decodeDocument(path, unwrapForced(converted.stdout)) };
  }
  return undefined;
});

/**
 * Read the machine's policy from wherever an administrator put it: a configuration profile on
 * macOS, or the policy file. Two sources are refused rather
 * than merged, so what applies is never a mix nobody wrote.
 */
export const readManagedPolicy = Effect.fn("readManagedPolicy")(function* (
  platform: NodeJS.Platform,
) {
  const filePath = managedPolicyPath(platform);
  const [platformPolicy, file] = yield* Effect.all([
    readPlatformPolicy(platform),
    readManagedPolicyFile(filePath),
  ]);
  if (platformPolicy !== undefined && file !== undefined) {
    return yield* new ManagedPolicyFileError({
      path: platformPolicy.source,
      reason: `a policy file at ${filePath} also exists; deploy the policy one way`,
    });
  }
  return platformPolicy ?? (file === undefined ? undefined : { source: filePath, document: file });
});
