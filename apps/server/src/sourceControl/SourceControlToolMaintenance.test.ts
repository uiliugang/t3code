import { assert, it } from "@effect/vitest";
import {
  MeituanToolError,
  SourceControlToolError,
  type SourceControlTool,
  type SourceControlToolStartInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Installer from "./SourceControlToolInstaller.ts";
import * as Settings from "../serverSettings.ts";
import * as Maintenance from "./SourceControlToolMaintenance.ts";

const plan = (patch: Partial<SourceControlTool> = {}): Installer.ToolInstallationPlan => ({
  tool: {
    id: "git",
    label: "Git",
    status: "installed",
    version: "2.43.0",
    executablePath: "/usr/bin/git",
    command: "/usr/bin/apt-get install --yes --only-upgrade git",
    manualCommand: null,
    reason: null,
    phase: "idle",
    message: null,
    ...patch,
  },
  executable: "/usr/bin/apt-get",
  args: ["install", "--yes", "--only-upgrade", "git"],
});
const confirmation = (tool = plan().tool): SourceControlToolStartInput => ({
  id: tool.id,
  expectedVersion: tool.version,
  expectedPath: tool.executablePath,
  expectedCommand: tool.command ?? "unsupported",
});
type InstallerMock = Omit<Installer.SourceControlToolInstaller["Service"], "inspectMeituan"> &
  Partial<Pick<Installer.SourceControlToolInstaller["Service"], "inspectMeituan">>;
const testLayer = (installer: InstallerMock) =>
  Maintenance.layer.pipe(
    Layer.provide(
      Layer.succeed(Installer.SourceControlToolInstaller, {
        inspectMeituan: (id) => Effect.fail(new MeituanToolError({ id, reason: "inspection" })),
        ...installer,
      }),
    ),
    Layer.provide(Settings.ServerSettingsService.layerTest({ meituanIntegrationEnabled: true })),
  );

it.effect(
  "rejects stale confirmations and unsupported installations without running an installer",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const installer = {
        inspect: (id: SourceControlTool["id"]) =>
          Effect.succeed(plan(id === "github" ? { id, command: null } : {})),
        install: () =>
          Effect.sync(() => {
            calls++;
            return "installed" as const;
          }),
      };
      yield* Effect.gen(function* () {
        const service = yield* Maintenance.SourceControlToolMaintenance;
        for (const changed of [
          { expectedVersion: "2.42.0" },
          { expectedPath: "/other/git" },
          { expectedCommand: "arbitrary command" },
        ]) {
          const error = yield* service.start({ ...confirmation(), ...changed }).pipe(Effect.flip);
          assert.strictEqual(error.reason, "changed");
        }
        const error = yield* service.start({ ...confirmation(), id: "github" }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "unsupported");
        assert.strictEqual(calls, 0);
      }).pipe(Effect.provide(testLayer(installer)));
    }),
);

it.effect("keeps an environment busy through verification and publishes the verified version", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let installed = false;
    let toolVersion = "1.0.0";
    const installer = {
      inspectMeituan: (id: "ones2" | "mcm" | "mtskills") =>
        Effect.succeed({
          ...plan().tool,
          id,
          version: toolVersion,
          command: null,
          phase: "idle" as const,
          message: null,
        }),
      inspect: (id: SourceControlTool["id"]) =>
        Effect.succeed(plan({ id, version: installed ? "2.44.0" : "2.43.0" })),
      install: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          installed = true;
          return "installed" as const;
        }),
    };
    yield* Effect.gen(function* () {
      const service = yield* Maintenance.SourceControlToolMaintenance;
      yield* service.refresh;
      yield* Effect.scoped(service.start(confirmation()));
      yield* Deferred.await(entered);
      toolVersion = "2.0.0";
      const meituanTools = Option.getOrThrow(yield* Stream.runHead(service.meituanChanges));
      assert.strictEqual(meituanTools.find((tool) => tool.id === "ones2")?.version, toolVersion);
      yield* service.refresh;
      const running = yield* Stream.runHead(service.changes);
      assert.strictEqual(
        Option.getOrThrow(running).find((tool) => tool.id === "git")?.phase,
        "running",
      );
      const busy = yield* service.start({ ...confirmation(), id: "github" }).pipe(Effect.flip);
      assert.strictEqual(busy.reason, "busy");
      yield* Deferred.succeed(release, undefined);
      const complete = yield* service.changes.pipe(
        Stream.filter((tools) => tools.some((tool) => tool.phase === "succeeded")),
        Stream.runHead,
      );
      assert.strictEqual(
        Option.getOrThrow(complete).find((tool) => tool.id === "git")?.version,
        "2.44.0",
      );
    }).pipe(Effect.provide(testLayer(installer)));
  }),
);

it.effect.each([
  { name: "unchanged active version", after: { version: "2.43.0" }, phase: "unchanged" },
  { name: "downgraded version", after: { version: "2.42.0" }, phase: "failed" },
  {
    name: "different active path",
    after: { version: "2.44.0", executablePath: "/other/git" },
    phase: "failed",
  },
  { name: "missing binary", after: { version: null, executablePath: null }, phase: "failed" },
] as const)("does not report update success for $name", (test) => {
  let installed = false;
  return Effect.gen(function* () {
    const service = yield* Maintenance.SourceControlToolMaintenance;
    yield* service.start(confirmation());
    const result = yield* service.changes.pipe(
      Stream.filter((tools) => tools.some((tool) => tool.phase === test.phase)),
      Stream.runHead,
    );
    assert.strictEqual(
      Option.getOrThrow(result).find((tool) => tool.id === "git")?.phase,
      test.phase,
    );
  }).pipe(
    Effect.provide(
      testLayer({
        inspect: () => Effect.succeed(plan(installed ? test.after : {})),
        install: () =>
          Effect.sync(() => {
            installed = true;
            return "installed" as const;
          }),
      }),
    ),
  );
});

it.effect("retains installer failures and permits a retry", () => {
  let attempts = 0;
  return Effect.gen(function* () {
    const service = yield* Maintenance.SourceControlToolMaintenance;
    yield* service.start(confirmation());
    const failure = yield* service.changes.pipe(
      Stream.filter((tools) => tools.some((tool) => tool.phase === "failed")),
      Stream.runHead,
    );
    assert.ok(Option.getOrThrow(failure).find((tool) => tool.id === "git")?.message);
    yield* service.start(confirmation());
    yield* service.changes.pipe(
      Stream.filter((tools) => tools.some((tool) => tool.phase === "unchanged")),
      Stream.runHead,
    );
    assert.strictEqual(attempts, 2);
  }).pipe(
    Effect.provide(
      testLayer({
        inspect: () => Effect.succeed(plan()),
        install: () =>
          Effect.suspend(() =>
            ++attempts === 1
              ? Effect.fail(
                  new SourceControlToolError({ id: "git", reason: "installation", exitCode: 1 }),
                )
              : Effect.succeed("current" as const),
          ),
      }),
    ),
  );
});

it.effect("reports inspection failures as unknown rather than a missing executable", () => {
  const inspected: string[] = [];
  return Effect.gen(function* () {
    const service = yield* Maintenance.SourceControlToolMaintenance;
    const result = Option.getOrThrow(yield* Stream.runHead(service.changes));
    assert.deepStrictEqual(inspected.toSorted(), ["git", "github", "meituan"]);
    const meituanResult = Option.getOrThrow(yield* Stream.runHead(service.meituanChanges));
    assert.deepStrictEqual(inspected.toSorted(), [
      "git",
      "github",
      "mcm",
      "meituan",
      "mtskills",
      "ones2",
    ]);
    assert.deepStrictEqual(
      result.map((tool) => tool.id).toSorted(),
      ["git", "github", "meituan"].toSorted(),
    );
    assert.deepStrictEqual(
      meituanResult.map((tool) => tool.id).toSorted(),
      ["mcm", "mtskills", "ones2"].toSorted(),
    );
    assert.ok(
      [...result, ...meituanResult].every(
        (tool) => tool.status === "unknown" && tool.command === null && tool.reason !== null,
      ),
    );
  }).pipe(
    Effect.provide(
      testLayer({
        inspect: (id) => {
          inspected.push(id);
          return Effect.fail(new SourceControlToolError({ id, reason: "inspection" }));
        },
        inspectMeituan: (id) => {
          inspected.push(id);
          return Effect.fail(new MeituanToolError({ id, reason: "inspection" }));
        },
        install: () => Effect.die("An uninspected tool must not be installed"),
      }),
    ),
  );
});
