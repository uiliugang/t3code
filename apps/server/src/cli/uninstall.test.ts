import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { posixLauncherScript } from "../cloud/pinnedRuntime.ts";
import { findOwnedLauncher, findRecordedLaunchers, uninstallCommand } from "./uninstall.ts";

afterEach(() => vi.restoreAllMocks());

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("t3 uninstall command", (it) => {
  it.effect.each([
    {
      label: "names another home's service it leaves installed",
      otherFromRead: 1,
      removed: [],
      output: "--base-dir '/home/me/.t3'",
    },
    {
      label: "leaves a service that serves another home by the time it is removed",
      otherFromRead: 2,
      removed: [],
      output: "Left the background service: it now serves another T3 home.",
    },
  ])("$label", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-cli-test-" });
      const uninstalls: Array<true> = [];
      let reads = 0;
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.sync(() => ({
              supported: true,
              installed: true,
              current: true,
              installedBaseDir: "/home/me/.t3",
              ...(++reads >= input.otherFromRead ? { otherBaseDir: "/home/me/.t3" } : {}),
              unitPath: "/home/me/.config/systemd/user/t3code.service",
              logPath: "/home/me/.t3/userdata/logs/boot-service.log",
            })),
            withStopped: (operation) => operation,
            restart: Effect.die("unexpected restart"),
            install: () => Effect.die("unexpected install"),
            uninstall: Effect.sync(() => {
              uninstalls.push(true);
              return true;
            }),
          }),
        ),
      );

      const output = yield* Command.runWith(uninstallCommand, { version: packageJson.version })([
        "--base-dir",
        baseDir,
        "--yes",
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      assert.deepStrictEqual(uninstalls, input.removed);
      assert.include(output, input.output);
    }),
  );
});

it.layer(NodeServices.layer)("t3 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // macOS spells the temp folder /var but resolves it to /private/var.
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-uninstall-" })
        .pipe(Effect.flatMap(fs.realPath));
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/t3");
      const theirs = path.join(root, "other/bin/t3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
      // A script launcher execs by absolute path, so argv0 names the executable.
      const scriptDir = path.join(root, "script-bin");
      const script = path.join(scriptDir, "t3");
      yield* fs.makeDirectory(scriptDir);
      yield* fs.writeFileString(script, posixLauncherScript(exe), { mode: 0o755 });
      assert.equal(
        yield* findOwnedLauncher({ launchedAs: exe, versionsDir }).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: scriptDir }),
        ),
        script,
      );
      const editedScript = path.join(scriptDir, "t3-edited");
      yield* fs.writeFileString(editedScript, `${posixLauncherScript(exe)}# mine\n`);

      // npx can run another version than the installed one, so uninstall also reads the
      // recorded launchers: through a symlinked home, and dangling after a prune.
      const throughAlias = path.join(root, "bin/t3-alias");
      const pruned = path.join(root, "bin/t3-pruned");
      const scriptThroughAlias = path.join(scriptDir, "t3-alias");
      const prunedScript = path.join(scriptDir, "t3-pruned");
      yield* fs.symlink(root, path.join(root, "alias"));
      yield* fs.symlink(path.join(root, "alias/runtime/versions/1.0.0/t3"), throughAlias);
      yield* fs.symlink(path.join(versionsDir, "0.9.0/t3"), pruned);
      yield* fs.writeFileString(
        scriptThroughAlias,
        posixLauncherScript(path.join(root, "alias/runtime/versions/1.0.0/t3")),
        { mode: 0o755 },
      );
      yield* fs.writeFileString(
        prunedScript,
        posixLauncherScript(path.join(versionsDir, "0.9.0/t3")),
        { mode: 0o755 },
      );
      // Another program inside a version is not a launcher.
      const sibling = path.join(root, "bin/t3-sibling");
      yield* fs.symlink(path.join(versionsDir, "1.0.0/node"), sibling);
      yield* fs.writeFileString(
        path.join(root, "runtime/launchers"),
        [
          ours,
          theirs,
          copy,
          throughAlias,
          pruned,
          sibling,
          script,
          scriptThroughAlias,
          prunedScript,
          editedScript,
          path.join(root, "missing"),
        ].join("\n") + "\n",
      );
      for (const dir of [versionsDir, path.join(root, "alias/runtime/versions")]) {
        assert.deepStrictEqual(yield* findRecordedLaunchers(dir), [
          ours,
          throughAlias,
          pruned,
          script,
          scriptThroughAlias,
          prunedScript,
        ]);
      }
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});
