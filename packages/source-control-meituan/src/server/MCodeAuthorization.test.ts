import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { make } from "./MCodeAuthorization.ts";

const host = "git.sankuai.com";
const settings = (mis = "", attempted: readonly string[] = []) => ({
  ...DEFAULT_SERVER_SETTINGS,
  sourceControlHosts: { meituan: { mis, authorizationAttemptedMis: attempted } },
});

const runProbe: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
  Effect.succeed(
    TestHost.processOutput(input.args[0] === "--version" ? "0.1.27" : "", {
      exitCode: ChildProcessSpawner.ExitCode(input.args[0] === "--version" ? 0 : 1),
      stderr: input.args[0] === "--version" ? "" : "error: no token found. Run code-cli auth login",
    }),
  );

describe("Meituan authorization", () => {
  it.effect.each(["", "   ", "bad mis", "bad\nmis"])(
    "never sends without a valid configured MIS: %j",
    (mis) =>
      Effect.scoped(
        Effect.gen(function* () {
          let logins = 0;
          const auth = yield* make.pipe(
            Effect.provide(
              TestHost.layer({
                settings: settings(mis),
                process: {
                  run: (input) => {
                    if (input.args.includes("login")) logins++;
                    return runProbe(input);
                  },
                },
              }),
            ),
          );
          yield* auth.discovery.probe("/repo");
          expect(Result.isFailure(yield* auth.signIn.start(host).pipe(Effect.result))).toBe(true);
          expect(logins).toBe(0);
        }),
      ),
  );

  it.effect.each([
    {
      name: "MOA",
      stdout: "Logged in to http://git.sankuai.com as zhangsan (via MCode CLI)",
      expected: "authenticated",
    },
    {
      name: "authenticated",
      stdout: "Logged in to http://git.sankuai.com as zhangsan",
      expected: "authenticated",
    },
    {
      name: "offline",
      stdout: "Logged in to http://git.sankuai.com as zhangsan (offline)",
      expected: "unknown",
    },
    { name: "unknown", stdout: "unrecognized status", expected: "unknown" },
  ] as const)("does not send for $name status", ({ name, stdout, expected }) =>
    Effect.scoped(
      Effect.gen(function* () {
        let logins = 0;
        const auth = yield* make.pipe(
          Effect.provide(
            TestHost.layer({
              settings: settings(name === "MOA" ? "" : "zhangsan"),
              process: {
                run: (input) => {
                  expect(input.env?.MCODE_SKIP_MOA).not.toBe("1");
                  if (input.args.includes("login")) logins++;
                  return input.args[0] === "--version"
                    ? runProbe(input)
                    : Effect.succeed(
                        TestHost.processOutput(stdout, {
                          exitCode: ChildProcessSpawner.ExitCode(0),
                        }),
                      );
                },
              },
            }),
          ),
        );
        expect((yield* auth.discovery.probe("/repo")).auth.status).toBe(expected);
        expect(logins).toBe(0);
      }),
    ),
  );

  it.effect(
    "deduplicates concurrent discoveries and manual sends, persists the first attempt, and permits an explicit resend",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sent = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const calls: string[] = [];
          const testLayer = TestHost.layer({
            settings: settings("zhangsan"),
            process: {
              run: (input) => {
                if (!input.args.includes("login")) return runProbe(input);
                calls.push(input.env?.MIS_ID ?? "");
                return Deferred.succeed(sent, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.as(TestHost.processOutput("Logged in as zhangsan")),
                );
              },
            },
          });
          yield* Effect.gen(function* () {
            const auth = yield* make;
            yield* Effect.all([auth.discovery.probe("/repo"), auth.discovery.probe("/repo")], {
              concurrency: 2,
            });
            yield* Deferred.await(sent);
            yield* auth.signIn.start(host);
            expect(calls).toEqual(["zhangsan"]);
            const saved = yield* (yield* SourceControlHost.SourceControlHost).settings.get;
            expect(saved.sourceControlHosts.meituan?.authorizationAttemptedMis).toEqual([
              "zhangsan",
            ]);
            yield* Deferred.succeed(finish, undefined);
            expect(yield* auth.signIn.wait(host)).toEqual({ account: "zhangsan" });
            const restarted = yield* make;
            yield* restarted.discovery.probe("/repo");
            expect(calls).toHaveLength(1);
            yield* restarted.signIn.start(host);
            yield* restarted.signIn.wait(host);
            expect(calls).toEqual(["zhangsan", "zhangsan"]);
          }).pipe(Effect.provide(testLayer));
        }),
      ),
  );

  it.effect("does not retry failed automatic requests and reports missing CIBA configuration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let logins = 0;
        const auth = yield* make.pipe(
          Effect.provide(
            TestHost.layer({
              settings: settings("zhangsan"),
              process: {
                run: (input) => {
                  if (!input.args.includes("login")) return runProbe(input);
                  logins++;
                  return Effect.succeed(
                    TestHost.processOutput("", {
                      exitCode: ChildProcessSpawner.ExitCode(1),
                      stderr: "cannot obtain sandbox IDENTIFIER",
                    }),
                  );
                },
              },
            }),
          ),
        );
        yield* auth.discovery.probe("/repo");
        const result = yield* auth.signIn.wait(host).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        const discovered = yield* auth.discovery.probe("/repo");
        expect(discovered.authorization?.status).toBe("failed");
        expect(discovered.authorization?.detail).toContain("IDENTIFIER");
        expect(logins).toBe(1);
      }),
    ),
  );

  it.effect("cancels the pending process and releases waiters without an automatic resend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const auth = yield* make.pipe(
          Effect.provide(
            TestHost.layer({
              settings: settings("zhangsan"),
              process: {
                run: (input) =>
                  input.args.includes("login")
                    ? Deferred.succeed(sent, undefined).pipe(
                        Effect.andThen(Effect.never),
                        Effect.ensuring(Deferred.succeed(stopped, undefined)),
                      )
                    : runProbe(input),
              },
            }),
          ),
        );
        yield* auth.signIn.start(host);
        yield* Deferred.await(sent);
        const waiting = yield* auth.signIn.wait(host).pipe(Effect.result, Effect.forkChild);
        yield* auth.signIn.cancel(host);
        yield* Deferred.await(stopped);
        expect(Result.isFailure(yield* Fiber.join(waiting))).toBe(true);
        expect((yield* auth.discovery.probe("/repo")).authorization?.status).toBe("idle");
      }),
    ),
  );
});
