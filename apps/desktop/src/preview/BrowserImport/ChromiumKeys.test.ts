import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { beforeEach, vi } from "vite-plus/test";

import { ChromiumKeyError, readLinuxSecret, resolveChromiumKeys } from "./ChromiumKeys.ts";
import { LinuxBrowserSecretPath } from "./LinuxBrowserSecret.ts";
import { BROWSER_IMPORT_SOURCES } from "./Sources.ts";

const { getPassword } = vi.hoisted(() => ({
  getPassword: vi.fn<() => Promise<string | undefined>>(),
}));

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    getPassword() {
      throw new Error("synchronous keychain read");
    }
  },
  AsyncEntry: class {
    getPassword = getPassword;
  },
}));

beforeEach(() => {
  getPassword.mockReset();
});

type CapturedCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly stdin?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  };
};

const layerHelper = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutStream?: Stream.Stream<Uint8Array>;
  readonly stderrStream?: Stream.Stream<Uint8Array>;
  readonly exitCode?: number;
  readonly spawnError?: PlatformError.PlatformError;
  readonly capture?: (command: CapturedCommand) => void;
}) =>
  Layer.merge(
    Layer.succeed(LinuxBrowserSecretPath, "/bundled/browser-secret/t3-browser-secret"),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        input.spawnError
          ? Effect.fail(input.spawnError)
          : Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: input.stdoutStream ?? Stream.encodeText(Stream.make(input.stdout ?? "")),
                stderr: input.stderrStream ?? Stream.encodeText(Stream.make(input.stderr ?? "")),
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            ).pipe(
              Effect.tap(() => Effect.sync(() => input.capture?.(command as CapturedCommand))),
            ),
      ),
    ),
  );

describe("macOS Chromium secrets", () => {
  const request = {
    platform: "darwin",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    linuxSecretApplication: undefined,
  } as const;
  const layerNoProcesses = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("must not spawn")),
  );

  it.effect("derives the cookie key from the keychain secret", () =>
    Effect.gen(function* () {
      getPassword.mockResolvedValue("macos-secret");
      const keys = yield* resolveChromiumKeys(request);
      expect(keys.cbcV10?.toString("hex")).toBe("3df7306fb1eac353289565a2f6b64f74");
    }).pipe(Effect.provide(layerNoProcesses)),
  );

  it.effect("reports a keychain entry the async read resolves as undefined", () =>
    Effect.gen(function* () {
      getPassword.mockResolvedValue(undefined);
      const error = yield* resolveChromiumKeys(request).pipe(Effect.flip);
      expect(error.reason).toBe("keychainItemMissing");
    }).pipe(Effect.provide(layerNoProcesses)),
  );

  it.effect("preserves a denied keychain approval", () =>
    Effect.gen(function* () {
      const denied = new Error("User denied access");
      getPassword.mockRejectedValue(denied);
      const error = yield* resolveChromiumKeys(request).pipe(Effect.flip);
      expect(error.reason).toBe("needsKeychainApproval");
      expect(error.cause).toBe(denied);
    }).pipe(Effect.provide(layerNoProcesses)),
  );
});

describe("Linux Chromium secrets", () => {
  it.effect("retains a missing helper failure alongside the keyring-free fallback", () =>
    Effect.gen(function* () {
      const keys = yield* resolveChromiumKeys({
        platform: "linux",
        keychainService: undefined,
        keychainAccount: undefined,
        linuxSecretApplication: "chromium",
      });
      expect(keys.cbcV10).toHaveLength(16);
      expect(keys.cbcV11).toBeUndefined();
      expect(keys.cbcV11Error?.reason).toBe("keychainUnavailable");
    }).pipe(
      Effect.provide(
        layerHelper({
          spawnError: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
          }),
        }),
      ),
    ),
  );

  it.effect("reports an unconfigured helper without searching PATH", () =>
    readLinuxSecret("chromium").pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe("keychainUnavailable"))),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("must not spawn")),
      ),
      Effect.provideService(LinuxBrowserSecretPath, undefined),
    ),
  );

  it.effect("derives Vivaldi's Linux key while preserving whitespace in the stored secret", () => {
    let captured: CapturedCommand | undefined;
    return Effect.gen(function* () {
      const source = BROWSER_IMPORT_SOURCES.find((source) => source.id === "vivaldi")!;
      const keys = yield* resolveChromiumKeys({
        platform: "linux",
        keychainService: source.keychainService,
        keychainAccount: source.keychainAccount,
        linuxSecretApplication: source.linuxSecretApplication,
      });
      expect(captured?.args).toEqual(["chrome"]);
      expect(keys.cbcV11?.toString("hex")).toBe("95aa769d6a5beca14d5d90ae655db112");
    }).pipe(
      Effect.provide(
        layerHelper({ stdout: "linux-secret \t\n", capture: (value) => (captured = value) }),
      ),
    );
  });

  it.effect("drains stdout and stderr concurrently", () =>
    Effect.gen(function* () {
      const stderrDrainStarted = yield* Deferred.make<void>();
      const stdout = Stream.fromEffect(Deferred.await(stderrDrainStarted)).pipe(
        Stream.flatMap(() => Stream.encodeText(Stream.make("linux-secret"))),
      );
      const stderr = Stream.fromEffect(Deferred.succeed(stderrDrainStarted, undefined)).pipe(
        Stream.drain,
      );

      const secret = yield* readLinuxSecret("chrome").pipe(
        Effect.provide(layerHelper({ stdoutStream: stdout, stderrStream: stderr })),
      );

      expect(secret).toBe("linux-secret");
    }),
  );

  it.effect(
    "preserves the desktop environment and identifies denial without parsing stderr",
    () => {
      let captured: CapturedCommand | undefined;
      return Effect.gen(function* () {
        const error = yield* readLinuxSecret("brave").pipe(Effect.flip);
        expect(error).toBeInstanceOf(ChromiumKeyError);
        expect(error.reason).toBe("needsKeychainApproval");
        expect(captured?.options.env?.LC_ALL).toBe("localized");
        expect(captured?.options.env?.PATH).toBe("/synthetic/bin");
        expect(captured?.options.env?.SESSION_MARKER).toBe("kept");
      }).pipe(
        Effect.provide(
          layerHelper({
            stderr: "Zugriff verweigert",
            exitCode: 3,
            capture: (value) => (captured = value),
          }),
        ),
        Effect.provideService(HostProcess.Environment, {
          PATH: "/synthetic/bin",
          SESSION_MARKER: "kept",
          LC_ALL: "localized",
        }),
      );
    },
  );
});
