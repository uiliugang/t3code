import {
  SourceControlSignInError,
  type SourceControlProviderDiscoveryItem,
  type SourceControlSignInPrompt,
} from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import type { SourceControlSignIn } from "@t3tools/source-control-core/server/driver";
import {
  probeSourceControlProvider,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { definition } from "../shared/definition.ts";
import { discovery as cliDiscovery, parseMCodeAuth } from "./MCodeCli.ts";

const HOST = "git.sankuai.com";
const MCODE_HOST = `http://${HOST}`;
const LOGIN_FAILED =
  "MOA sign-in failed. Check that MOA is signed in on the server, then try again.";
const failure = (
  detail: string,
  reason: "failed" | "cancelled" | "not-started" | "unsupported" = "failed",
) => new SourceControlSignInError({ provider: definition.kind, host: HOST, reason, detail });

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  let current:
    | {
        prompt: SourceControlSignInPrompt;
        done: Deferred.Deferred<{ readonly account: string }, SourceControlSignInError>;
        fiber: Fiber.Fiber<boolean>;
      }
    | undefined;
  let state: NonNullable<SourceControlProviderDiscoveryItem["authorization"]> = { status: "idle" };

  const begin = Effect.fn("MCodeAuthorization.begin")(function* () {
    if (current && state.status === "pending") return current.prompt;
    const done = yield* Deferred.make<{ readonly account: string }, SourceControlSignInError>();
    const prompt = {
      delivery: "moa" as const,
      expiresAt: (yield* Clock.currentTimeMillis) + 180_000,
    };
    state = { status: "pending" };
    const login = host.process
      .run({
        operation: "MCodeAuthorization.login",
        command: "code-cli",
        args: ["auth", "login", "--moa"],
        cwd: ".",
        env: { MCODE_HOST },
        allowNonZeroExit: true,
        timeoutMs: 150_000,
        maxOutputBytes: 16_000,
      })
      .pipe(
        Effect.mapError(() => failure(LOGIN_FAILED)),
        Effect.flatMap((output) =>
          output.exitCode === 0
            ? host.process
                .run({
                  operation: "MCodeAuthorization.verify",
                  command: "code-cli",
                  args: cliDiscovery.authArgs,
                  cwd: ".",
                  env: { MCODE_HOST, MCODE_SKIP_MOA: "1" },
                  allowNonZeroExit: true,
                  timeoutMs: 20_000,
                  maxOutputBytes: 8_000,
                })
                .pipe(
                  Effect.map(parseMCodeAuth),
                  Effect.mapError(() => failure(LOGIN_FAILED)),
                  Effect.flatMap((auth) =>
                    auth.status === "authenticated" && Option.isSome(auth.account)
                      ? Effect.succeed({ account: auth.account.value })
                      : Effect.fail(failure(LOGIN_FAILED)),
                  ),
                )
            : Effect.fail(failure(LOGIN_FAILED)),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            state = { status: "succeeded" };
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            state = { status: "failed", detail: error.detail };
          }),
        ),
      );
    const fiber = yield* login.pipe(Deferred.into(done), Effect.forkIn(scope));
    current = { prompt, done, fiber };
    return prompt;
  });

  const signIn: SourceControlSignIn = {
    start: Effect.fn("MCodeAuthorization.start")(function* (hostname) {
      if (hostname !== HOST)
        return yield* failure("Meituan Code only signs in to git.sankuai.com.", "unsupported");
      return yield* lock.withPermits(1)(begin());
    }),
    wait: Effect.fn("MCodeAuthorization.wait")(function* (hostname) {
      if (hostname !== HOST || !current)
        return yield* failure("No Meituan Code authorization is in progress.", "not-started");
      return yield* Deferred.await(current.done);
    }),
    cancel: Effect.fn("MCodeAuthorization.cancel")(function* (hostname) {
      if (hostname !== HOST) return;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (!current || state.status !== "pending") return;
          yield* Deferred.fail(current.done, failure("Authorization was cancelled.", "cancelled"));
          yield* Fiber.interrupt(current.fiber);
          state = { status: "idle" };
        }),
      );
    }),
    access: () => Effect.succeed("signed-out"),
  };

  const discovery: SourceControlManagedCliDiscoverySpec = {
    ...cliDiscovery,
    type: "managed-cli",
    probe: Effect.fn("MCodeAuthorization.probe")(function* (cwd) {
      const item = yield* probeSourceControlProvider({
        spec: cliDiscovery,
        process: {
          run: (input) =>
            host.process.run({
              ...input,
              env: { ...input.env, MCODE_HOST },
            }),
        },
        cwd,
      });
      return {
        ...item,
        authorization:
          item.auth.status === "authenticated" && state.status !== "pending"
            ? { status: "succeeded" as const }
            : state,
      };
    }),
    refineUnknownRemote: () => Effect.succeed(null),
  };
  return { signIn, discovery };
});
