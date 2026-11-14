import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as NpmRelease from "./npmRelease.ts";

const version = "0.1.5-nightly.20261030.1";
const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const noPublicRegistry = HttpClient.make(() =>
  Effect.die("a configured npm lookup must not fall back to public npm"),
);
// A fake npm on PATH decides whether npm counts as installed.
const makeService = Effect.fnUntraced(function* (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  publicRegistry: HttpClient.HttpClient = noPublicRegistry,
  npmInstalled = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const npmBin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-release-" });
  for (const name of ["npm", "npm.cmd"]) {
    yield* fs.writeFileString(path.join(npmBin, name), "", { mode: 0o755 });
  }
  return yield* NpmRelease.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(HttpClient.HttpClient, publicRegistry),
    Effect.provideService(HostProcess.Environment, {
      PATH: npmInstalled ? npmBin : "",
      PATHEXT: ".CMD",
    }),
  );
}, Effect.provide(NodeServices.layer));

it.effect.each([
  {
    spec: version,
    stdout: JSON.stringify({ version, t3code: { databaseMigration: 42 } }),
    migration: 42,
  },
  {
    spec: "nightly",
    stdout: JSON.stringify([{ version, t3code: { databaseMigration: 42 } }]),
    migration: 42,
  },
  { spec: "latest", stdout: JSON.stringify(version), migration: undefined },
])("reads $spec through npm and retains migration compatibility metadata", (fixture) =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const service = yield* makeService((input) => {
      calls.push(input);
      return Effect.succeed(output(fixture.stdout));
    });
    const expected = {
      version,
      ...(fixture.migration === undefined ? {} : { databaseMigration: fixture.migration }),
    };
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: expect.stringMatching(/[/\\]npm(?:\.cmd)?$/i),
      args: ["view", "--global", "--json", `t3@${fixture.spec}`, "version", "t3code"],
      maxOutputBytes: 256 * 1024,
    });
    yield* TestClock.adjust("1 minute");
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(calls).toHaveLength(2);
  }),
);

it.effect("treats a registry 404 as unpublished without trying another registry", () =>
  Effect.gen(function* () {
    const service = yield* makeService(() =>
      Effect.succeed(output('{"error":{"code":"E404"}}', 1)),
    );
    expect(yield* service.get({ spec: version })).toBeNull();
  }),
);

const spawnFailure = () =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: "npm",
      argumentCount: 6,
      cause: new Error("EACCES"),
    }),
  );

it.effect("checks fork releases without consulting npm and caches the result for one hour", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(
      () => Effect.die("fork releases must not consult npm"),
      HttpClient.make((request) => {
        urls.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify([
                { tag_name: "v0.0.5", draft: true },
                { tag_name: "v0.0.4", prerelease: true },
                { tag_name: "v0.0.4-nightly.20261107.1" },
                { tag_name: "v0.0.3" },
              ]),
            ),
          ),
        );
      }),
    );
    expect(yield* service.get({ spec: "latest", source: "github" })).toEqual({ version: "0.0.3" });
    expect(yield* service.get({ spec: "latest", source: "github" })).toEqual({ version: "0.0.3" });
    expect(urls).toEqual([
      "https://api.github.com/repos/uiliugang/t3code/releases?per_page=100&page=1",
    ]);
    yield* TestClock.adjust({ minutes: 59, seconds: 59 });
    expect(yield* service.get({ spec: "latest", source: "github" })).toEqual({ version: "0.0.3" });
    expect(urls).toHaveLength(1);
    yield* TestClock.adjust("1 second");
    expect(yield* service.get({ spec: "latest", source: "github" })).toEqual({ version: "0.0.3" });
    expect(urls).toHaveLength(2);
  }),
);

it.effect.each([
  { path: "pagination", outcome: "success" },
  { path: "pagination", outcome: "timeout" },
  { path: "fallback", outcome: "success" },
  { path: "fallback", outcome: "timeout" },
])("gives each GitHub request its own timeout: $path / $outcome", (fixture) =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<string>();
    const respond = yield* Queue.unbounded<void>();
    const completed = yield* Deferred.make<void>();
    const service = yield* makeService(
      () => Effect.die("fork releases must not consult npm"),
      HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Queue.offer(started, request.url);
          yield* Queue.take(respond);
          const firstPage = request.url.endsWith("page=1");
          const response = new Response(
            JSON.stringify(
              firstPage
                ? Array.from({ length: 100 }, () => ({
                    tag_name: "v0.0.13-nightly.20261114.1",
                    prerelease: true,
                  }))
                : [{ tag_name: "v0.0.12" }],
            ),
            { status: firstPage && fixture.path === "fallback" ? 403 : 200 },
          );
          if (!firstPage && fixture.path === "fallback") {
            Object.defineProperty(response, "url", {
              value: "https://github.com/uiliugang/t3code/releases/tag/v0.0.12",
            });
          }
          return HttpClientResponse.fromWeb(request, response);
        }),
      ),
    );
    const lookup = yield* service.get({ spec: "latest", source: "github" }).pipe(
      Effect.result,
      Effect.tap(() => Deferred.succeed(completed, undefined)),
      Effect.forkChild,
    );
    expect(yield* Queue.take(started)).toContain("page=1");
    yield* TestClock.adjust("8 seconds");
    yield* Queue.offer(respond, undefined);
    expect(yield* Queue.take(started)).toContain(
      fixture.path === "fallback" ? "/releases/latest" : "page=2",
    );
    if (fixture.outcome === "success") {
      yield* TestClock.adjust("8 seconds");
      yield* Queue.offer(respond, undefined);
      expect(yield* Fiber.join(lookup)).toEqual(Result.succeed({ version: "0.0.12" }));
    } else {
      yield* TestClock.adjust("14 seconds");
      expect(yield* Deferred.isDone(completed)).toBe(false);
      yield* TestClock.adjust("1 second");
      expect(yield* Deferred.isDone(completed)).toBe(true);
      expect(Result.isFailure(yield* Fiber.join(lookup))).toBe(true);
    }
  }),
);

it.effect.each(["headers", "body"])("bounds GitHub request %s with one timeout", (stage) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const headers = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const service = yield* makeService(
      () => Effect.die("fork releases must not consult npm"),
      HttpClient.make((request) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(
            stage === "headers"
              ? Effect.never
              : Deferred.await(headers).pipe(
                  Effect.as(
                    HttpClientResponse.fromWeb(request, new Response(new ReadableStream())),
                  ),
                ),
          ),
        ),
      ),
    );
    const lookup = yield* service.get({ spec: "latest", source: "github" }).pipe(
      Effect.result,
      Effect.tap(() => Deferred.succeed(completed, undefined)),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    if (stage === "body") {
      yield* TestClock.adjust("8 seconds");
      yield* Deferred.succeed(headers, undefined);
    }
    yield* TestClock.adjust(stage === "body" ? "6 seconds" : "14 seconds");
    expect(yield* Deferred.isDone(completed)).toBe(false);
    yield* TestClock.adjust("1 second");
    expect(yield* Deferred.isDone(completed)).toBe(true);
    expect(Result.isFailure(yield* Fiber.join(lookup))).toBe(true);
  }),
);

it.effect.each([403, 429])("checks the latest release when GitHub returns %s", (status) =>
  Effect.gen(function* () {
    const service = yield* makeService(
      () => Effect.die("fork releases must not consult npm"),
      HttpClient.make((request) => {
        const response = request.url.startsWith("https://api.github.com/")
          ? new Response('{"message":"API rate limit exceeded"}', { status })
          : new Response(null);
        if (request.url === "https://github.com/uiliugang/t3code/releases/latest") {
          Object.defineProperty(response, "url", {
            value: "https://github.com/uiliugang/t3code/releases/tag/v0.0.12",
          });
        }
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    );
    expect(yield* service.get({ spec: "latest", source: "github" })).toEqual({
      version: "0.0.12",
    });
  }),
);

it.effect.each([
  "https://github.com/uiliugang/t3code/releases/tag/v0.0.12-nightly.20261113.1",
  "https://github.com/another/fork/releases/tag/v0.0.12",
  "https://github.com/uiliugang/t3code/releases",
])("rejects an unexpected latest-release destination: %s", (url) =>
  Effect.gen(function* () {
    let requests = 0;
    const service = yield* makeService(
      () => Effect.die("fork releases must not consult npm"),
      HttpClient.make((request) => {
        requests++;
        const response = new Response(null, {
          status: request.url.startsWith("https://api.github.com/") ? 403 : 200,
        });
        Object.defineProperty(response, "url", { value: url });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    );
    const result = yield* service.get({ spec: "latest", source: "github" }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.message).not.toContain("npm registry");
    expect(requests).toBe(2);
    yield* TestClock.adjust({ minutes: 59, seconds: 59 });
    expect(yield* service.get({ spec: "latest", source: "github" }).pipe(Effect.result)).toEqual(
      result,
    );
    expect(requests).toBe(2);
    yield* TestClock.adjust("1 second");
    expect(yield* service.get({ spec: "latest", source: "github" }).pipe(Effect.result)).toEqual(
      result,
    );
    expect(requests).toBe(4);
  }),
);

it.effect.each([
  output("not json"),
  output('{"error":{"code":"E401","detail":"sensitive"}}', 1),
  output('{"version":"9.9.9"}'),
  output("[]"),
  output("", 9009),
  { ...output(JSON.stringify({ version })), stdoutTruncated: true },
  { ...output(JSON.stringify({ version })), timedOut: true },
  "spawn failure",
] as const)("reports an unavailable lookup rather than an unpublished release: %j", (result) =>
  Effect.gen(function* () {
    const service = yield* makeService(() =>
      result === "spawn failure" ? spawnFailure() : Effect.succeed(result),
    );
    const found = yield* service.get({ spec: version }).pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) {
      expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
      expect(found.failure.message).not.toContain("sensitive");
    }
  }),
);

it.effect("falls back to public npm only when npm is not installed", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(
      () => Effect.die("npm is not installed"),
      HttpClient.make((request) => {
        urls.push(request.url);
        const response = request.url.endsWith("/nightly")
          ? new Response(JSON.stringify({ version, t3code: { databaseMigration: 42 } }))
          : request.url.endsWith("/latest")
            ? new Response(new ReadableStream())
            : new Response("{}", { status: 404 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
      false,
    );
    expect(yield* service.get({ spec: "nightly" })).toEqual({ version, databaseMigration: 42 });
    expect(yield* service.get({ spec: "9.9.9" })).toBeNull();
    const stalled = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(Result.isFailure(yield* Fiber.join(stalled))).toBe(true);
    expect(urls).toEqual([
      "https://registry.npmjs.org/t3/nightly",
      "https://registry.npmjs.org/t3/9.9.9",
      "https://registry.npmjs.org/t3/latest",
    ]);
  }),
);

it.effect("runs at most two npm lookups at once", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    let running = 0;
    let peak = 0;
    const service = yield* makeService(() =>
      Effect.gen(function* () {
        peak = Math.max(peak, ++running);
        yield* Queue.offer(started, undefined);
        yield* Deferred.await(release);
        running--;
        return output('{"error":{"code":"E404"}}', 1);
      }),
    );
    const lookups = yield* Effect.forEach(
      ["1.0.0", "1.0.1", "1.0.2"],
      (spec) => service.get({ spec }),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Queue.take(started);
    yield* Queue.take(started);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(lookups)).toEqual([null, null, null]);
    expect(peak).toBe(2);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before spawning npm: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* makeService(() => Effect.die("invalid specs must not spawn npm"));
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
    }),
);
