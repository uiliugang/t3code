// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// OSCrypt key derivation Chromium uses; Effect has no equivalent.
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { LinuxBrowserSecretPath } from "./LinuxBrowserSecret.ts";

const KEY_SALT = "saltysalt";
const KEY_LENGTH = 16;
const MAC_KEY_ITERATIONS = 1003;
const LINUX_KEY_ITERATIONS = 1;
/** Chromium's documented fallback passphrase when no Linux keyring is present. */
const LINUX_FALLBACK_PASSPHRASE = "peanuts";

export const ChromiumKeyFailure = Schema.Literals([
  "needsKeychainApproval",
  "keychainItemMissing",
  "keychainUnavailable",
  "unsupportedPlatform",
  "readFailed",
]);
export type ChromiumKeyFailure = typeof ChromiumKeyFailure.Type;

export class ChromiumKeyError extends Schema.TaggedError<
  ChromiumKeyError,
  { readonly brand: unique symbol }
>()("ChromiumKeyError", {
  reason: ChromiumKeyFailure,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not obtain the Chromium cookie key: ${this.reason}.`;
  }
}

export interface ChromiumKeyMaterial {
  readonly cbcV10?: Buffer;
  readonly cbcV11?: Buffer;
  readonly cbcV11Error?: ChromiumKeyError;
  /** Linux clients can encrypt with an empty passphrase; retry it on failure (crbug.com/1195256). */
  readonly cbcEmpty?: Buffer;
}

const derive = (passphrase: string, iterations: number) =>
  NodeCrypto.pbkdf2Sync(passphrase, KEY_SALT, iterations, KEY_LENGTH, "sha1");

// In-process Keychain access attributes grants to this app. Keep modal prompts untimed to preserve their listener.
const readKeychainSecret = Effect.fn("ChromiumKeys.readKeychainSecret")(function* (
  service: string,
  account: string,
) {
  // Loading the macOS binding at startup can prevent other platforms from opening.
  const Keyring = yield* Effect.tryPromise({
    try: () => import("@napi-rs/keyring"),
    catch: (cause) => new ChromiumKeyError({ reason: "keychainUnavailable", cause }),
  });
  const secret = yield* Effect.tryPromise({
    try: () => new Keyring.AsyncEntry(service, account).getPassword(),
    catch: (cause) => {
      const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
      const missing = /no (matching )?entry|not found/i.test(message);
      return new ChromiumKeyError({
        reason: missing ? "keychainItemMissing" : "needsKeychainApproval",
        cause,
      });
    },
  });
  if (!secret) {
    return yield* new ChromiumKeyError({ reason: "keychainItemMissing" });
  }
  return secret;
});

/** Exit codes distinguish missing keys, denied access, and unavailable keyrings without localized message parsing. */
export const readLinuxSecret = Effect.fn("ChromiumKeys.readLinuxSecret")(function* (
  application: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = yield* HostProcess.Environment;
      const helper = yield* LinuxBrowserSecretPath;
      if (helper === undefined) {
        return yield* new ChromiumKeyError({ reason: "keychainUnavailable" });
      }
      const handle = yield* spawner
        .spawn(ChildProcess.make(helper, [application], { stdin: "ignore", env: environment }))
        .pipe(
          Effect.mapError(
            (cause) => new ChromiumKeyError({ reason: "keychainUnavailable", cause }),
          ),
        );
      const [secret, , exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.runDrain),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new ChromiumKeyError({ reason: "keychainUnavailable", cause })),
      );
      if (Number(exitCode) !== 0) {
        return yield* new ChromiumKeyError({
          reason:
            Number(exitCode) === 2
              ? "keychainItemMissing"
              : Number(exitCode) === 3
                ? "needsKeychainApproval"
                : "keychainUnavailable",
        });
      }
      if (secret === "") {
        return yield* new ChromiumKeyError({ reason: "keychainItemMissing" });
      }
      return secret;
    }),
  );
});

export interface ChromiumKeyRequest {
  readonly platform: NodeJS.Platform;
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
  readonly linuxSecretApplication: string | undefined;
}

export const resolveChromiumKeys = Effect.fn("ChromiumKeys.resolveChromiumKeys")(function* (
  request: ChromiumKeyRequest,
): Effect.fn.Return<
  ChromiumKeyMaterial,
  ChromiumKeyError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  if (request.platform === "darwin") {
    if (!request.keychainService || !request.keychainAccount) {
      return yield* new ChromiumKeyError({ reason: "unsupportedPlatform" });
    }
    const secret = yield* readKeychainSecret(request.keychainService, request.keychainAccount);
    return { cbcV10: derive(secret, MAC_KEY_ITERATIONS) };
  }

  if (request.platform === "linux") {
    // v10 always uses the fallback passphrase; a keyring secret additionally unlocks v11.
    const keyringSecret = request.linuxSecretApplication
      ? yield* readLinuxSecret(request.linuxSecretApplication).pipe(
          // Missing Secret Service or keys must not block v10; explicit denial, lock, or cancellation remains a consent failure.
          Effect.catchIf(
            (error) => error.reason !== "needsKeychainApproval",
            (error) => Effect.succeed(error),
          ),
        )
      : undefined;
    return {
      cbcV10: derive(LINUX_FALLBACK_PASSPHRASE, LINUX_KEY_ITERATIONS),
      ...(typeof keyringSecret === "string"
        ? { cbcV11: derive(keyringSecret, LINUX_KEY_ITERATIONS) }
        : keyringSecret
          ? { cbcV11Error: keyringSecret }
          : {}),
      cbcEmpty: derive("", LINUX_KEY_ITERATIONS),
    };
  }

  return yield* new ChromiumKeyError({ reason: "unsupportedPlatform" });
});
