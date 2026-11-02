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
import * as Semaphore from "effect/Semaphore";
import { definition, readMis } from "../shared/definition.ts";
import { discovery as cliDiscovery } from "./MCodeCli.ts";

const HOST = "git.sankuai.com";
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
        mis: string;
        prompt: SourceControlSignInPrompt;
        done: Deferred.Deferred<{ readonly account: string }, SourceControlSignInError>;
        fiber: Fiber.Fiber<boolean>;
      }
    | undefined;
  let state: NonNullable<SourceControlProviderDiscoveryItem["authorization"]> = { status: "idle" };

  const begin = Effect.fn("MCodeAuthorization.begin")(function* (automatic: boolean) {
    const settings = yield* host.settings.get.pipe(
      Effect.mapError(() => failure("Could not read the Meituan Code settings.")),
    );
    const fields = settings.sourceControlHosts.meituan;
    const mis = readMis(fields);
    if (!mis) return yield* failure("Configure a valid MIS ID before requesting authorization.");
    if (current && state.status === "pending") {
      if (current.mis === mis) return current.prompt;
      return yield* failure("Cancel the pending authorization before changing its recipient.");
    }
    const attempted = Array.isArray(fields?.authorizationAttemptedMis)
      ? fields.authorizationAttemptedMis.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    if (automatic && attempted.includes(mis)) return;
    // Persist before sending so a restart or a lost response never sends another automatic request.
    yield* host.settings
      .update({
        sourceControlHosts: {
          meituan: { authorizationAttemptedMis: [...new Set([...attempted, mis])] },
        },
      })
      .pipe(
        Effect.mapError(() => failure("Could not save the Meituan Code authorization attempt.")),
      );
    const done = yield* Deferred.make<{ readonly account: string }, SourceControlSignInError>();
    const prompt = {
      delivery: "daxiang" as const,
      mis,
      expiresAt: (yield* Clock.currentTimeMillis) + 180_000,
    };
    state = { status: "pending" };
    const login = host.process
      .run({
        operation: "MCodeAuthorization.login",
        command: "code-cli",
        args: ["auth", "login", "--ciba"],
        cwd: ".",
        env: { MIS_ID: mis, MCODE_HOST: "http://git.sankuai.com" },
        allowNonZeroExit: true,
        timeoutMs: 200_000,
        maxOutputBytes: 16_000,
      })
      .pipe(
        Effect.mapError(() =>
          failure("Could not run code-cli authorization. Check the server and send again."),
        ),
        Effect.flatMap((output) => {
          if (output.exitCode === 0) return Effect.succeed({ account: mis });
          const detail = /IDENTIFIER/u.test(output.stderr)
            ? "CIBA requires the server's sandbox IDENTIFIER. Configure it on the server, then send again."
            : /timed out|expired/iu.test(output.stderr)
              ? "Authorization expired. Send a new request when you are ready."
              : /denied|reject|cancel/iu.test(output.stderr)
                ? "Authorization was declined. Send again when you are ready."
                : "Could not complete authorization. Check code-cli on the server, then send again.";
          return Effect.fail(failure(detail));
        }),
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
    current = { mis, prompt, done, fiber };
    return prompt;
  });

  const signIn: SourceControlSignIn = {
    start: Effect.fn("MCodeAuthorization.start")(function* (hostname) {
      if (hostname !== HOST)
        return yield* failure("Meituan Code only signs in to git.sankuai.com.", "unsupported");
      const prompt = yield* lock.withPermits(1)(begin(false));
      if (!prompt)
        return yield* failure("No Meituan Code authorization is in progress.", "not-started");
      return prompt;
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
              env: { ...input.env, MCODE_HOST: "http://git.sankuai.com" },
            }),
        },
        cwd,
      });
      if (item.status === "available" && item.auth.status === "unauthenticated") {
        yield* lock.withPermits(1)(begin(true)).pipe(Effect.ignore);
      }
      return { ...item, authorization: state };
    }),
    refineUnknownRemote: () => Effect.succeed(null),
  };
  return { signIn, discovery };
});
