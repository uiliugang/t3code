import {
  SkillManagerError,
  type DiscoveredSkill,
  type SkillOrigin,
  type SkillTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SkillPackages from "./SkillPackages.ts";

const isSkillManagerError = Schema.is(SkillManagerError);
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      skillName: Schema.String,
      sourceType: Schema.String,
      sourceId: Schema.Union([Schema.String, Schema.Number]),
      targetDir: Schema.optionalKey(Schema.String),
    }),
  ),
);
export const makeSkillDiscovery = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packages = yield* SkillPackages.SkillPackages;
  const origin = Effect.fn("SkillDiscovery.origin")(function* (directory: string) {
    const recordFile = path.join(path.dirname(directory), ".mtskills-source.jsonl");
    const records = yield* Effect.gen(function* () {
      if (Number((yield* fs.stat(recordFile)).size) > 1024 * 1024) return "";
      return yield* fs.readFileString(recordFile);
    }).pipe(Effect.orElseSucceed(() => ""));
    for (const line of records.trim().split("\n").toReversed()) {
      const record = yield* Effect.try(() => decodeRecord(line)).pipe(Effect.option);
      if (record._tag !== "Some" || record.value.skillName !== path.basename(directory)) continue;
      const value = record.value;
      if (value.targetDir && path.resolve(value.targetDir) !== path.dirname(directory)) continue;
      if (value.sourceType === "mt-name" || value.sourceType === "mt-id")
        return {
          sourceId: "meituan",
          locator: value.sourceType === "mt-id" ? "mt" : String(value.sourceId),
          skill: value.sourceType === "mt-id" ? String(value.sourceId) : "",
          evidence: recordFile,
        } satisfies SkillOrigin;
    }
    let parent = directory;
    for (let depth = 0; depth < 6; depth++) {
      const config = yield* fs
        .readFileString(path.join(parent, ".git", "config"))
        .pipe(Effect.orElseSucceed(() => ""));
      const remote = /\[remote "origin"\][^[]*?\burl\s*=\s*([^\r\n]+)/.exec(config)?.[1]?.trim();
      if (remote && /^(https?:\/\/|git@|ssh:\/\/)/.test(remote))
        return {
          sourceId: "community",
          locator: remote,
          skill: path.basename(directory),
          evidence: path.join(parent, ".git", "config"),
        } satisfies SkillOrigin;
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return undefined;
  });
  const describe = Effect.fn("SkillDiscovery.describe")(
    function* (file: string) {
      const directory = path.basename(file) === "SKILL.md" ? path.dirname(file) : file;
      const real = yield* fs.realPath(directory);
      const data = yield* packages.metadata(real);
      const external = /[/\\](?:plugins|\.system|\.plugin-cache)[/\\]/.test(real);
      const source = external ? undefined : ((yield* origin(directory)) ?? (yield* origin(real)));
      return {
        ...data,
        identity: real,
        path: path.join(directory, "SKILL.md"),
        external,
        ...(source ? { origin: source } : {}),
      };
    },
    Effect.mapError((cause) =>
      isSkillManagerError(cause)
        ? cause
        : new SkillManagerError({ operation: "discover", reason: "io", cause }),
    ),
  );
  const scan = Effect.fn("SkillDiscovery.scan")(function* (
    targets: ReadonlyArray<SkillTarget>,
    reported: ReadonlyArray<{ name: string; path: string; provider: string }>,
    managedRoot: string,
    managedPaths: ReadonlySet<string>,
  ) {
    const found = new Map<string, DiscoveredSkill>();
    const add = Effect.fn("SkillDiscovery.add")(function* (
      file: string,
      provider: string,
      targetId?: string,
    ) {
      const result = yield* describe(file).pipe(Effect.result);
      if (result._tag === "Failure") return;
      const item = result.success;
      if (item.identity.startsWith(managedRoot + path.sep) || managedPaths.has(item.path)) return;
      const previous = found.get(item.identity);
      found.set(item.identity, {
        ...item,
        provider: previous?.provider ?? provider,
        providers: [...new Set([...(previous?.providers ?? []), provider])],
        paths: [...new Set([...(previous?.paths ?? []), item.path])],
        targetIds: [...new Set([...(previous?.targetIds ?? []), ...(targetId ? [targetId] : [])])],
      });
    });
    for (const item of reported.slice(0, 2000)) yield* add(item.path, item.provider);
    for (const target of targets) {
      const entries = yield* fs
        .readDirectory(target.directory)
        .pipe(Effect.orElseSucceed(() => []));
      for (const name of entries.toSorted().slice(0, 1000)) {
        if (name.startsWith(".")) continue;
        yield* add(path.join(target.directory, name), target.label, target.id);
      }
    }
    return [...found.values()].toSorted(
      (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
    );
  });
  return { describe, scan };
});
