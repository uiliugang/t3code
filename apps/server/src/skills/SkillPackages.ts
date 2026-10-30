import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as YAML from "yaml";
import { SkillManagerError, type SkillSource } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as ServerConfig from "../config.ts";

const metadataSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)),
  description: Schema.String.check(Schema.isMinLength(1)),
  version: Schema.optionalKey(Schema.String),
});
const decodeMetadata = Schema.decodeUnknownEffect(metadataSchema);
const isSkillManagerError = Schema.is(SkillManagerError);
interface PackageInput {
  readonly source: SkillSource;
  readonly locator: string;
  readonly skill: string;
  readonly staging: string;
}
interface PackageFile {
  readonly path: string;
  readonly hash: string;
  readonly text: string;
}
interface PackageContents {
  readonly name: string;
  readonly description: string;
  readonly digest: string;
  readonly directory: string;
  readonly version?: string;
  readonly files: ReadonlyArray<PackageFile>;
  readonly truncated: boolean;
}
export class SkillPackages extends Context.Service<
  SkillPackages,
  {
    readonly prepare: (source: SkillSource) => Effect.Effect<string, SkillManagerError>;
    readonly metadata: (
      directory: string,
    ) => Effect.Effect<{ readonly name: string; readonly description: string }, SkillManagerError>;
    readonly inspect: (
      directory: string,
      destination?: string,
    ) => Effect.Effect<PackageContents, SkillManagerError>;
    readonly diagnose: (source: SkillSource) => Effect.Effect<void, SkillManagerError>;
    readonly fetch: (input: PackageInput) => Effect.Effect<PackageContents, SkillManagerError>;
  }
>()("t3/skills/SkillPackages") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

  const readMetadata = Effect.fn("SkillPackages.readMetadata")(function* (directory: string) {
    if (Number((yield* fs.stat(path.join(directory, "SKILL.md"))).size) > 1024 * 1024)
      return yield* new SkillManagerError({ operation: "metadata", reason: "invalid-package" });
    const contents = yield* fs.readFileString(path.join(directory, "SKILL.md"));
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
    if (!match?.[1])
      return yield* new SkillManagerError({ operation: "metadata", reason: "invalid-package" });
    const data = yield* Effect.try({
      try: () => YAML.parse(match[1]!),
      catch: (cause) =>
        new SkillManagerError({ operation: "metadata", reason: "invalid-package", cause }),
    });
    return yield* decodeMetadata(data);
  });

  const run = Effect.fn("SkillPackages.runInstaller")(
    function* (binary: string, args: string[], cwd: string, registry: string) {
      const env = {
        ...environment,
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        CI: "1",
        ...(registry ? { npm_config_registry: registry } : {}),
      };
      const resolved = yield* resolveSpawnCommand(binary, args, { env });
      const result = yield* spawnAndCollect(
        binary,
        ChildProcess.make(resolved.command, resolved.args, { cwd, env, shell: resolved.shell }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      if (result.code !== 0) {
        const diagnostic = `${result.stderr} ${result.stdout}`;
        const reason = /unauthori[sz]ed|authentication|login|\b401\b|\b403\b/i.test(diagnostic)
          ? "authentication"
          : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed/i.test(diagnostic)
            ? "network"
            : "installer-failed";
        return yield* new SkillManagerError({ operation: "install", reason });
      }
    },
    Effect.timeout("5 minutes"),
    Effect.mapError((cause) =>
      isSkillManagerError(cause)
        ? cause
        : new SkillManagerError({ operation: "install", reason: "installer-missing", cause }),
    ),
  );

  const prepare = Effect.fn("SkillPackages.prepare")(
    function* (source: SkillSource) {
      if (source.kind === "local") return "";
      const directory = path.join(config.stateDir, "skills", "tools", source.kind);
      yield* fs.makeDirectory(directory, { recursive: true });
      const spec = source.kind === "skills" ? "skills@1.7.4" : "@mtfe/mtskills@9.6.0";
      yield* run(
        "npm",
        ["install", "--prefix", directory, "--no-audit", "--no-fund", spec],
        directory,
        source.registry,
      );
      return path.join(
        directory,
        "node_modules",
        ".bin",
        `${source.kind === "skills" ? "skills" : "mtskills"}${platform === "win32" ? ".cmd" : ""}`,
      );
    },
    Effect.mapError((cause) =>
      isSkillManagerError(cause)
        ? cause
        : new SkillManagerError({ operation: "prepare", reason: "io", cause }),
    ),
  );

  const mapError = (cause: unknown) =>
    isSkillManagerError(cause)
      ? cause
      : new SkillManagerError({ operation: "package", reason: "io", cause });
  const metadata = Effect.fn("SkillPackages.metadata")(readMetadata, Effect.mapError(mapError));
  const inspect = Effect.fn("SkillPackages.inspect")(function* (
    directory: string,
    destination?: string,
  ) {
    const sourceRoot = yield* fs.realPath(directory);
    const selected = yield* readMetadata(sourceRoot);
    if (destination) yield* fs.makeDirectory(destination, { recursive: true });
    const manifest: PackageFile[] = [];
    let textBytes = 0;
    let truncated = false;
    const hashes: string[] = [];
    let bytes = 0;
    let files = 0;
    const copy = Effect.fn("SkillPackages.copy")(function* (
      directory: string,
      relative: string,
      ancestors: ReadonlySet<string>,
    ): Effect.fn.Return<void, SkillManagerError | import("effect/PlatformError").PlatformError> {
      const real = yield* fs.realPath(directory);
      if (!inside(sourceRoot, real) || ancestors.has(real))
        return yield* new SkillManagerError({ operation: "copy", reason: "invalid-package" });
      const next = new Set([...ancestors, real]);
      for (const name of (yield* fs.readDirectory(directory)).toSorted()) {
        if (name === ".git" || name === "node_modules") continue;
        const file = path.join(directory, name);
        const target = destination ? path.join(destination, relative, name) : undefined;
        if (!inside(sourceRoot, yield* fs.realPath(file)))
          return yield* new SkillManagerError({ operation: "copy", reason: "invalid-package" });
        const info = yield* fs.stat(file);
        if (info.type === "Directory") {
          if (++files > 1000)
            return yield* new SkillManagerError({ operation: "copy", reason: "invalid-package" });
          if (target) yield* fs.makeDirectory(target, { recursive: true });
          yield* copy(file, path.join(relative, name), next);
        } else if (info.type === "File") {
          bytes += Number(info.size);
          if (++files > 1000 || bytes > 25 * 1024 * 1024)
            return yield* new SkillManagerError({ operation: "copy", reason: "invalid-package" });
          const contents = yield* fs.readFile(file);
          const digest = Hex.encode(yield* crypto.digest("SHA-256", contents).pipe(Effect.orDie));
          hashes.push(
            `${path.join(relative, name).split(path.sep).join("/")}\0${info.mode & 0o111}\0${digest}`,
          );
          const includeText =
            contents.length <= 8192 &&
            textBytes + contents.length <= 65536 &&
            !contents.includes(0);
          const text = includeText ? new TextDecoder().decode(contents) : "";
          textBytes += includeText ? contents.length : 0;
          truncated ||= !includeText;
          manifest.push({
            path: path.join(relative, name).split(path.sep).join("/"),
            hash: `${info.mode & 0o111}:${digest}`,
            text,
          });
          if (target) {
            yield* fs.writeFile(target, contents);
            yield* fs.chmod(target, info.mode & 0o777);
          }
        } else
          return yield* new SkillManagerError({ operation: "copy", reason: "invalid-package" });
      }
    });
    yield* copy(sourceRoot, "", new Set());
    const digest = Hex.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(hashes.join("\0")))
        .pipe(Effect.orDie),
    );
    return {
      name: selected.name,
      description: selected.description,
      digest,
      directory: destination ?? sourceRoot,
      ...(selected.version ? { version: selected.version } : {}),
      files: manifest,
      truncated,
    };
  }, Effect.mapError(mapError));
  const diagnose = Effect.fn("SkillPackages.diagnose")(function* (source: SkillSource) {
    if (!source.enabled)
      return yield* new SkillManagerError({ operation: "diagnose", reason: "source-disabled" });
    if (source.kind === "local") return;
    const binary = source.executable || (source.kind === "mtskills" ? "mtskills" : "npx");
    yield* run(
      binary,
      !source.executable && source.kind === "skills"
        ? ["--no-install", "skills", "--version"]
        : ["--version"],
      config.stateDir,
      source.registry,
    );
  });

  const fetch = Effect.fn("SkillPackages.fetch")(
    function* (input: PackageInput) {
      if (!input.source.enabled)
        return yield* new SkillManagerError({ operation: "fetch", reason: "source-disabled" });
      if (input.locator.startsWith("-") || input.skill.startsWith("-"))
        return yield* new SkillManagerError({ operation: "fetch", reason: "invalid-package" });
      yield* fs.makeDirectory(input.staging, { recursive: true });
      let root: string;
      if (input.source.kind === "local") {
        root = yield* fs.realPath(expandHomePath(input.locator, home));
      } else if (input.source.kind === "mtskills") {
        root = path.join(input.staging, "download");
        const args = ["i", input.locator, "--target-dir", root, "-y"];
        if (input.locator === "mt") {
          if (!/^\d+$/.test(input.skill))
            return yield* new SkillManagerError({ operation: "fetch", reason: "invalid-package" });
          args.push("--id", input.skill);
        }
        yield* run(
          input.source.executable || "mtskills",
          args,
          input.staging,
          input.source.registry,
        );
      } else {
        root = path.join(input.staging, ".agents", "skills");
        const args = [
          "add",
          input.locator,
          "--agent",
          "universal",
          "--yes",
          "--json",
          ...(input.skill ? ["--skill", input.skill] : ["--skill", "*"]),
        ];
        yield* run(
          input.source.executable || "npx",
          input.source.executable ? args : ["--yes", "skills@1.7.4", ...args],
          input.staging,
          input.source.registry,
        );
      }
      const candidates: Array<{ name: string; description: string; directory: string }> = [];
      let visited = 0;
      const discover = Effect.fn("SkillPackages.discover")(function* (
        directory: string,
        depth: number,
      ): Effect.fn.Return<
        void,
        | SkillManagerError
        | import("effect/PlatformError").PlatformError
        | import("effect/Schema").SchemaError
      > {
        if (++visited > 2000 || depth > 6) return;
        if (yield* fs.exists(path.join(directory, "SKILL.md"))) {
          const data = yield* readMetadata(directory);
          if (
            !input.skill ||
            input.locator === "mt" ||
            data.name === input.skill ||
            path.basename(directory) === input.skill
          )
            candidates.push({ ...data, directory });
          return;
        }
        for (const entry of (yield* fs.readDirectory(directory)).toSorted()) {
          if (entry === ".git" || entry === "node_modules") continue;
          const child = path.join(directory, entry);
          if ((yield* fs.stat(child)).type === "Directory") yield* discover(child, depth + 1);
        }
      });
      yield* discover(root, 0);
      if (candidates.length !== 1)
        return yield* new SkillManagerError({
          operation: "discover",
          reason: candidates.length ? "select-skill" : "invalid-package",
          choices: candidates.map((candidate) => candidate.name),
        });
      const selected = candidates[0]!;
      return yield* inspect(selected.directory, path.join(input.staging, "package"));
    },
    Effect.mapError((cause) =>
      isSkillManagerError(cause)
        ? cause
        : new SkillManagerError({ operation: "fetch", reason: "io", cause }),
    ),
  );
  return SkillPackages.of({ fetch, prepare, inspect, metadata, diagnose });
});

export const layer = Layer.effect(SkillPackages, make);
