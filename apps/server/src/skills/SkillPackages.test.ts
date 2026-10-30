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
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { "target-dir": { type: "string" }, yes: { type: "boolean", short: "y" }, id: { type: "string" } } });
if (positionals[0] !== "i" || !values.yes || !values["target-dir"] || realpathSync(dirname(values["target-dir"])) !== realpathSync(process.cwd())) process.exit(2);
const target = join(values["target-dir"], "custom-skill");
mkdirSync(target, { recursive: true });
writeFileSync(join(target, "SKILL.md"), "---\\nname: custom-skill\\ndescription: Custom installer package\\n---\\n");
writeFileSync(join(target, "resource.txt"), "bundled");
`,
      );
      yield* fs.chmod(script, 0o755);
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
      );
      expect(result.name).toBe("custom-skill");
      expect(yield* fs.readFileString(`${result.directory}/resource.txt`)).toBe("bundled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
