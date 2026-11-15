// @effect-diagnostics nodeBuiltinImport:off - Verifies actual zsh/bash startup with a fake CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderCliShell from "./ProviderCliShell.ts";
import { updateShellIntegration, renderProviderCommands } from "./ProviderCliShell.ts";

it("installs once and removes only its own block, preserving user shell configuration", () => {
  const original = "# NVM\nexport PATH=/nvm/bin:$PATH\n";
  const installed = updateShellIntegration(original, "/data with 'quotes'/env.sh");
  expect(installed).toContain(original);
  expect(updateShellIntegration(installed, "/data with 'quotes'/env.sh")).toBe(installed);
  expect(updateShellIntegration(installed, null)).toBe(original);
  expect(() =>
    updateShellIntegration("# >>> T3 provider commands >>>\nunfinished", null),
  ).toThrow();
});

it.live("keeps commands after user startup and NVM PATH changes in real zsh and bash", () =>
  Effect.gen(function* () {
    if (yield* HostProcess.isWindows) return;
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "provider-shell-" });
    const entry = `${home}/fake cli.mjs`;
    yield* fs.writeFileString(
      entry,
      "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 17;",
    );
    for (const file of [".zshrc", ".bashrc", ".bash_profile"])
      yield* fs.writeFileString(
        `${home}/${file}`,
        'export PATH="/nvm/fake/bin:$PATH"\nalias codex="false"\n',
      );
    const paths = yield* Effect.flatMap(ProviderCliShell.ProviderCliShell, (service) =>
      service.prepare(`${home}/t3 home`),
    ).pipe(
      Effect.provide(ProviderCliShell.layer),
      Effect.provideService(HostProcess.ExecutablePath, process.execPath),
      Effect.provideService(HostProcess.Arguments, [process.execPath, entry]),
      Effect.provideService(HostProcess.IsExecutable, false),
    );
    for (const shell of ["/bin/zsh", "/bin/bash"]) {
      if (!(yield* fs.exists(shell))) continue;
      const result = yield* Effect.promise(
        () =>
          new Promise<{ code: number | null; output: string }>((done, reject) => {
            const child = NodeChildProcess.spawn(
              shell,
              shell.endsWith("zsh")
                ? ["-lic", "codex 'a b' '--model=custom'"]
                : ["--rcfile", paths.bashRc, "-ic", "codex 'a b' '--model=custom'"],
              {
                env: {
                  ...process.env,
                  HOME: home,
                  ZDOTDIR: paths.zshDirectory,
                  T3CODE_ORIGINAL_ZDOTDIR: home,
                },
                stdio: ["ignore", "pipe", "ignore"],
              },
            );
            let output = "";
            child.stdout.on("data", (data) => {
              output += data;
            });
            child.once("error", reject);
            child.once("close", (code) => done({ code, output }));
          }),
      );
      expect(result.code).toBe(17);
      expect(JSON.parse(result.output)).toEqual([
        "__provider-cli",
        `${home}/t3 home`,
        "codex",
        "a b",
        "--model=custom",
      ]);
    }
    const originalRc = yield* fs.readFileString(`${home}/.zshrc`);
    for (const operation of ["install", "uninstall"]) {
      const result = yield* Effect.promise(
        () =>
          new Promise<number | null>((done, reject) => {
            const child = NodeChildProcess.spawn(
              process.execPath,
              [
                NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
                "terminal",
                operation,
                "--base-dir",
                `${home}/t3`,
              ],
              {
                env: {
                  ...process.env,
                  HOME: home,
                  SHELL: "/bin/zsh",
                  ZDOTDIR: paths.zshDirectory,
                  T3CODE_ORIGINAL_ZDOTDIR: home,
                },
                stdio: "ignore",
              },
            );
            child.once("error", reject);
            child.once("close", done);
          }),
      );
      expect(result).toBe(0);
      const rc = yield* fs.readFileString(`${home}/.zshrc`);
      if (operation === "install") expect(rc).toContain("# >>> T3 provider commands >>>");
      else expect(rc).toBe(originalRc);
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("uses absolute self invocation with shell-quoted paths and preserves argument boundaries", () => {
  const script = renderProviderCommands("/t3 home/userdata", {
    command: "/node's/bin/node",
    entrypoint: "/app with spaces/bin.ts",
  });
  expect(script).toContain("'\"'\"'");
  expect(script).toContain('"$@"');
  expect(script).toContain("__provider-cli");
  expect(script).not.toContain("PATH=");
});
