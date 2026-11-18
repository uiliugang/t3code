import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Settings from "../serverSettings.ts";
import * as Installer from "./SourceControlToolInstaller.ts";

const fixture = Effect.fn("test.toolInstaller")(function* (options: {
  binaries: ReadonlyArray<string>;
  platform?: NodeJS.Platform;
  uid?: number;
  owned?: boolean;
  npmVersion?: string;
  installExit?: number;
  meituanEnabled?: boolean;
  meituanRequirementsEnabled?: boolean;
  settingsUnavailable?: boolean;
  realProcess?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const bin = path.join(root, "bin");
  yield* fs.makeDirectory(bin);
  for (const name of options.binaries) {
    const real =
      name === "code-cli"
        ? path.join(root, "lib/node_modules/@ee/code-cli/main.js")
        : name === "npm"
          ? path.join(root, "lib/node_modules/npm/bin/npm-cli.js")
          : name === "git" && options.platform === "darwin"
            ? path.join(root, "Cellar/git/2.43.0/bin/git")
            : path.join(root, "executables", name);
    yield* fs.makeDirectory(path.dirname(real), { recursive: true });
    yield* fs.writeFileString(real, "");
    yield* fs.chmod(real, 0o755);
    yield* fs.symlink(real, path.join(bin, name));
  }
  const calls: VcsProcess.VcsProcessInput[] = [];
  const run: VcsProcess.VcsProcess["Service"]["run"] = (input) =>
    Effect.sync(() => {
      calls.push(input);
      const args = input.args;
      if (input.operation.endsWith("install"))
        return processOutput("", {
          exitCode: ChildProcessSpawner.ExitCode(options.installExit ?? 0),
        });
      if (args.includes("--version")) return processOutput("tool 2.43.0");
      if (args.includes("view"))
        return processOutput(JSON.stringify(options.npmVersion ?? "2.44.0"));
      if (args.includes("prefix") || args[0] === "--prefix") return processOutput(root);
      if (args[0] === "--cellar" && args.length === 1)
        return processOutput(path.join(root, "Cellar"));
      if (args[0] === "--search")
        return processOutput(options.owned === false ? "" : `git: ${args[1]}`);
      if (args[0] === "-qf") return processOutput(options.owned === false ? "custom-git" : "git");
      throw new Error(`Unexpected probe: ${input.command} ${args.join(" ")}`);
    });
  const context = yield* Layer.build(
    Installer.layer.pipe(
      Layer.provide(
        options.settingsUnavailable
          ? Layer.mock(Settings.ServerSettingsService)({
              getSettings: Effect.fail(
                new ServerSettingsError({
                  settingsPath: "<test>",
                  operation: "read-file",
                  cause: "unavailable",
                }),
              ),
            })
          : Settings.ServerSettingsService.layerTest({
              meituanIntegrationEnabled: options.meituanEnabled ?? true,
              meituanRequirementsEnabled: options.meituanRequirementsEnabled ?? true,
            }),
      ),
      Layer.provide(
        options.realProcess ? VcsProcess.layer : Layer.succeed(VcsProcess.VcsProcess, { run }),
      ),
      Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: bin })),
      Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "linux")),
      Layer.provide(Layer.succeed(HostProcess.UserId, options.uid ?? 0)),
    ),
  );
  return {
    installer: Context.get(context, Installer.SourceControlToolInstaller),
    calls,
    root,
    bin,
  };
});

it.effect("does not probe Meituan tools while the environment integration is disabled", () =>
  Effect.gen(function* () {
    const { installer, calls } = yield* fixture({
      binaries: ["code-cli", "npm"],
      meituanEnabled: false,
    });
    const result = yield* Effect.flip(installer.inspect("meituan"));
    assert.strictEqual(result.reason, "inspection");
    assert.isEmpty(calls);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  ["ones2", "@ee/mep-ones-cli"],
  ["mcm", "@dp/mcm-cli"],
  ["mtskills", "@mtfe/mtskills"],
] as const)("exposes %s status and its npm maintenance command", ([id, packageName]) =>
  Effect.gen(function* () {
    const { installer, bin } = yield* fixture({ binaries: [id] });
    const result = yield* installer.inspectMeituan(id);
    assert.strictEqual(result.status, "installed");
    assert.strictEqual(result.version, "2.43.0");
    assert.strictEqual(result.executablePath, `${bin}/${id}`);
    assert.strictEqual(result.command, null);
    assert.strictEqual(
      result.manualCommand,
      `npm install -g ${packageName}@latest --registry=http://r.npm.sankuai.com`,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["ones2", "mcm", "mtskills"] as const)(
  "offers the npm maintenance command for %s on Windows",
  (id) =>
    Effect.gen(function* () {
      const { installer } = yield* fixture({ binaries: [], platform: "win32" });
      const result = yield* installer.inspectMeituan(id);
      assert.strictEqual(result.status, "missing");
      assert.ok(result.manualCommand?.startsWith("npm install -g "));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each([[], ["mtskills"]])(
  "inspects the configured private installer with PATH binaries %j",
  (binaries) =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const { installer, root } = yield* fixture({ binaries, platform, realProcess: true });
      const fs = yield* FileSystem.FileSystem;
      const executable = `${root}/private/mtskills${platform === "win32" ? ".cmd" : ""}`;
      yield* fs.makeDirectory(`${root}/private`);
      const script =
        'if (!process.execArgv.includes("--conditions=private-installer")) process.exit(2);\nconst child = require("node:child_process").spawnSync("node", ["--version"]);\nif (child.status !== 0) process.exit(1);\nconsole.log("9.6.0");\n';
      if (platform === "win32") yield* fs.writeFileString(`${root}/private/cli.cjs`, script);
      yield* fs.writeFileString(
        executable,
        platform === "win32"
          ? '@node --conditions=private-installer "%~dp0cli.cjs" %*\r\n'
          : `${binaries.length ? "#!/no-longer-installed/bin/node" : "#!/usr/bin/env -S node"} --conditions=private-installer\n${script}`,
      );
      yield* fs.chmod(executable, 0o755);
      const result = yield* installer.inspectMeituan("mtskills", executable);
      assert.strictEqual(result.executablePath, executable);
      assert.strictEqual(result.version, "9.6.0");
      assert.isNull(result.manualCommand);
      yield* fs.remove(executable);
      const missing = yield* installer.inspectMeituan("mtskills", executable);
      assert.strictEqual(missing.status, "missing");
      assert.isNull(missing.manualCommand);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "provides the server Node to a Windows npm launcher without bypassing the batch file",
  () =>
    Effect.gen(function* () {
      const { installer, root, calls } = yield* fixture({ binaries: [], platform: "win32" });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const executable = path.join(root, "mtskills.cmd");
      const runtime = path.join(root, "test-host.exe");
      yield* fs.writeFileString(runtime, "fixture executable");
      yield* fs.writeFileString(path.join(root, "icudtl.dat"), "fixture ICU");
      yield* fs.writeFileString(
        executable,
        '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%~dp0cli.cjs" %*\r\n',
      );
      yield* installer
        .inspectMeituan("mtskills", executable)
        .pipe(Effect.provideService(HostProcess.ExecutablePath, runtime));
      assert.strictEqual(calls[0]?.command, executable);
      const bin = calls[0]?.env?.PATH?.split(";")[0];
      assert.isOk(bin);
      assert.strictEqual(
        yield* fs.readFileString(path.join(bin!, "node.exe")),
        "fixture executable",
      );
      assert.strictEqual(yield* fs.readFileString(path.join(bin!, "icudtl.dat")), "fixture ICU");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["ones2", "mcm"] as const)(
  "does not probe %s while requirements are disabled",
  (id) =>
    Effect.gen(function* () {
      const { installer, calls } = yield* fixture({
        binaries: [id],
        meituanRequirementsEnabled: false,
      });
      const result = yield* Effect.flip(installer.inspectMeituan(id));
      assert.strictEqual(result.reason, "inspection");
      assert.isEmpty(calls);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["apt-get", "yum", "dnf"] as const)(
  "updates only the package-owned Git via %s",
  (manager) =>
    Effect.gen(function* () {
      const { installer, bin } = yield* fixture({
        binaries: ["git", manager, "dpkg-query", "rpm", "sudo"],
        uid: 1000,
      });
      const result = yield* installer.inspect("git");
      assert.strictEqual(result.executable, `${bin}/sudo`);
      assert.deepStrictEqual(result.args.slice(0, 2), ["-n", `${bin}/${manager}`]);
      assert.ok(result.args.includes(manager === "apt-get" ? "--only-upgrade" : "upgrade"));
      assert.strictEqual(result.tool.executablePath, `${bin}/git`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not replace a custom installation with a distribution package", () =>
  Effect.gen(function* () {
    const { installer } = yield* fixture({ binaries: ["git", "yum", "rpm"], owned: false });
    const result = yield* installer.inspect("git");
    assert.strictEqual(result.executable, null);
    assert.strictEqual(result.tool.command, null);
    assert.ok(result.tool.reason);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("installs missing GitHub CLI and upgrades Homebrew-owned Git", () =>
  Effect.gen(function* () {
    const { installer, bin } = yield* fixture({
      binaries: ["git", "brew"],
      platform: "darwin",
      settingsUnavailable: true,
    });
    const git = yield* installer.inspect("git");
    assert.strictEqual(git.executable, `${bin}/brew`);
    assert.deepStrictEqual(git.args, ["upgrade", "git"]);
    const github = yield* installer.inspect("github");
    assert.strictEqual(github.tool.version, null);
    assert.deepStrictEqual(github.args, ["install", "gh"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps Meituan Code in its existing npm prefix and pins the checked version", () =>
  Effect.gen(function* () {
    const { installer, root, calls } = yield* fixture({ binaries: ["code-cli", "npm"] });
    const result = yield* installer.inspect("meituan");
    assert.ok(result.args.includes(root));
    assert.strictEqual(yield* installer.install(result), "installed");
    const install = calls.find((call) => call.operation.endsWith("install"));
    assert.ok(install?.args.includes("@ee/code-cli@2.44.0"));
    assert.ok(install?.args.includes("--registry=http://r.npm.sankuai.com"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["2.42.0", "2.43.0"])(
  "does not reinstall or downgrade Meituan Code to %s",
  (npmVersion) =>
    Effect.gen(function* () {
      const { installer, calls } = yield* fixture({ binaries: ["code-cli", "npm"], npmVersion });
      const result = yield* installer.inspect("meituan");
      assert.strictEqual(yield* installer.install(result), "current");
      assert.ok(calls.every((call) => !call.operation.endsWith("install")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a nonzero installer exit without exposing process output", () =>
  Effect.gen(function* () {
    const { installer } = yield* fixture({ binaries: ["apt-get"], installExit: 17 });
    const result = yield* installer.inspect("github");
    const error = yield* installer.install(result).pipe(Effect.flip);
    assert.strictEqual(error.reason, "installation");
    assert.strictEqual(error.exitCode, 17);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
