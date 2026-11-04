import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as SkillPackages from "./SkillPackages.ts";

it.live(
  "installs a custom mtskills package using its supported noninteractive target-directory protocol",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcess.Platform;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mtskills-protocol-" });
      const script = `${directory}/installer.mjs`;
      // mtskills 9.6 accepts --sync-agents, but does not define the negated option.
      yield* fs.writeFileString(
        script,
        `#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
if (spawnSync("node", ["--version"]).status !== 0) process.exit(3);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { "target-dir": { type: "string" }, yes: { type: "boolean", short: "y" }, id: { type: "string" } } });
if (positionals[0] !== "i" || !values.yes || !values["target-dir"] || realpathSync(dirname(values["target-dir"])) !== realpathSync(process.cwd())) process.exit(2);
const target = join(values["target-dir"], "custom-skill");
mkdirSync(target, { recursive: true });
writeFileSync(join(target, "SKILL.md"), "---\\nname: custom-skill\\ndescription: Custom installer package\\n---\\n");
writeFileSync(join(target, "resource.txt"), "bundled");
`,
      );
      yield* fs.chmod(script, 0o755);
      const staleBin = `${directory}/stale-bin`;
      yield* fs.makeDirectory(staleBin);
      yield* fs.writeFileString(`${staleBin}/node`, "#!/bin/sh\nexit 42\n");
      yield* fs.chmod(`${staleBin}/node`, 0o755);
      const runtime = platform === "win32" ? process.execPath : `${directory}/Electron`;
      if (platform !== "win32") yield* fs.symlink(process.execPath, runtime);
      const executable = platform === "win32" ? `${directory}/installer.cmd` : script;
      if (platform === "win32")
        yield* fs.writeFileString(executable, '@node "%~dp0installer.mjs" %*\r\n');
      const result = yield* Effect.gen(function* () {
        const packages = yield* SkillPackages.SkillPackages;
        return yield* packages.fetch({
          source: {
            id: "custom",
            label: "Internal market",
            kind: "mtskills",
            enabled: true,
            executable,
            registry: "",
          },
          locator: "custom-skill",
          skill: "",
          staging: `${directory}/staging`,
        });
      }).pipe(
        Effect.provide(
          SkillPackages.layer.pipe(Layer.provide(ServerConfig.layerTest(directory, directory))),
        ),
        Effect.provideService(HostProcess.Environment, {
          ...process.env,
          PATH: `${staleBin}${platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        }),
        Effect.provideService(HostProcess.ExecutablePath, runtime),
      );
      expect(result.name).toBe("custom-skill");
      expect(yield* fs.readFileString(`${result.directory}/resource.txt`)).toBe("bundled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("preserves installer diagnostics without credentials or terminal escapes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-failure-" });
    const script = `${directory}/installer.mjs`;
    yield* fs.writeFileString(
      script,
      `#!/usr/bin/env node
console.error("\\u001b[31mERR_UNKNOWN_BUILTIN_MODULE: node:stream/promises\\u001b[0m");
console.error("https://user:password@example.com/repo?token=private Bearer private-token");
console.log("x".repeat(10000));
process.exit(1);
`,
    );
    yield* fs.chmod(script, 0o755);
    const executable = platform === "win32" ? `${directory}/installer.cmd` : script;
    if (platform === "win32")
      yield* fs.writeFileString(executable, '@node "%~dp0installer.mjs" %*\r\n');
    const result = yield* Effect.gen(function* () {
      const packages = yield* SkillPackages.SkillPackages;
      return yield* packages.diagnose({
        id: "custom",
        label: "Custom",
        kind: "skills",
        enabled: true,
        executable,
        registry: "",
      });
    }).pipe(
      Effect.provide(
        SkillPackages.layer.pipe(Layer.provide(ServerConfig.layerTest(directory, directory))),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("SkillManagerError");
      if (result.failure._tag !== "SkillManagerError") return;
      expect(result.failure.diagnostics).toContain(
        "ERR_UNKNOWN_BUILTIN_MODULE: node:stream/promises",
      );
      expect(result.failure.diagnostics).toContain("exit code 1");
      expect(result.failure.diagnostics).not.toMatch(/password|private|\u001b/);
      expect(result.failure.diagnostics!.length).toBeLessThanOrEqual(4100);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
