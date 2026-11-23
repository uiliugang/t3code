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
  it.effect.each(["", "other-account"])(
    "signs in with the verified MOA account independently of the configured MIS: %j",
    (mis) =>
      Effect.scoped(
        Effect.gen(function* () {
          let logins = 0;
          const auth = yield* make.pipe(
            Effect.provide(
              TestHost.layer({
                settings: settings(mis, [mis]),
                process: {
                  run: (input) => {
                    if (input.args.includes("login")) {
                      expect(input.args).toEqual(["auth", "login", "--moa"]);
                      expect(input.env?.MIS_ID).toBeUndefined();
                      logins++;
                      return Effect.succeed(
                        TestHost.processOutput("Logged in as zhangsan (via MOA)"),
                      );
                    }
                    if (input.env?.MCODE_SKIP_MOA === "1") {
                      return Effect.succeed(
                        TestHost.processOutput("Logged in to http://git.sankuai.com as zhangsan"),
                      );
                    }
                    return runProbe(input);
                  },
                },
              }),
            ),
          );
          yield* auth.discovery.probe("/repo");
          expect(logins).toBe(0);
          expect(yield* auth.signIn.start(host)).toMatchObject({ delivery: "moa" });
          expect(yield* auth.signIn.wait(host)).toEqual({ account: "zhangsan" });
          expect(logins).toBe(1);
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

  it.effect("deduplicates concurrent sign-ins and permits an explicit retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        let logins = 0;
        const testLayer = TestHost.layer({
          settings: settings("zhangsan"),
          process: {
            run: (input) => {
              if (!input.args.includes("login")) {
                return Effect.succeed(
                  TestHost.processOutput("Logged in to http://git.sankuai.com as zhangsan"),
                );
              }
              logins++;
              return Deferred.succeed(sent, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.as(TestHost.processOutput("Logged in as zhangsan")),
              );
            },
          },
        });
        yield* Effect.gen(function* () {
          const auth = yield* make;
          const prompts = yield* Effect.all([auth.signIn.start(host), auth.signIn.start(host)], {
            concurrency: 2,
          });
          yield* Deferred.await(sent);
          expect(prompts[0]).toEqual(prompts[1]);
          expect(logins).toBe(1);
          yield* Deferred.succeed(finish, undefined);
          expect(yield* auth.signIn.wait(host)).toEqual({ account: "zhangsan" });
          yield* auth.signIn.start(host);
          yield* auth.signIn.wait(host);
          expect(logins).toBe(2);
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );

  it.effect.each([0, 1])(
    "reports failed MOA sign-in when login exits %i without valid credentials",
    (exitCode) =>
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
                        exitCode: ChildProcessSpawner.ExitCode(exitCode),
                        stderr: "MOA agent unreachable",
                      }),
                    );
                  },
                },
              }),
            ),
          );
          yield* auth.signIn.start(host);
          const result = yield* auth.signIn.wait(host).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          const discovered = yield* auth.discovery.probe("/repo");
          expect(discovered.authorization?.status).toBe("failed");
          expect(discovered.authorization?.detail).toContain("MOA sign-in failed");
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
