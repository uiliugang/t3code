import {
  SkillManagerError,
  type SkillCopyPackage,
  type SkillCopyPreviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Base64 from "effect/encoding/Base64";
import * as ServerConfig from "../config.ts";
import * as SkillPackages from "./SkillPackages.ts";

export const makeSkillCopy = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packages = yield* SkillPackages.SkillPackages;
  const config = yield* ServerConfig.ServerConfig;
  const root = path.join(config.stateDir, "skills", "copies");
  const invalid = () => new SkillManagerError({ operation: "copy", reason: "invalid-package" });
  const inside = (parent: string, child: string) =>
    child === parent || child.startsWith(parent + path.sep);
  const destination = Effect.fn("SkillCopy.destination")(function* (directory: string) {
    if (!path.isAbsolute(directory) || directory.includes("\0")) return yield* invalid();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === resolved) return yield* invalid();
    // Resolve existing ancestors as well, so a directory alias cannot overwrite T3's own storage.
    let ancestor = resolved;
    while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
    const canonical = path.resolve(yield* fs.realPath(ancestor), path.relative(ancestor, resolved));
    if (path.dirname(canonical) === canonical) return yield* invalid();
    const storage = yield* fs.realPath(config.stateDir);
    if (inside(storage, canonical) || inside(canonical, storage)) return yield* invalid();
    return canonical;
  });
  const exportPackage = Effect.fn("SkillCopy.exportPackage")(function* (directory: string) {
    const staging = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-export-" });
    const pkg = yield* packages.inspect(directory, staging);
    const files = yield* Effect.forEach(pkg.files, (file) =>
      Effect.gen(function* () {
        const location = path.join(staging, ...file.path.split("/"));
        return {
          path: file.path,
          contents: Base64.encode(yield* fs.readFile(location)),
          mode: (yield* fs.stat(location)).mode & 0o777,
        };
      }),
    );
    return { name: pkg.name, digest: pkg.digest, files };
  }, Effect.scoped);
  const preview = Effect.fn("SkillCopy.preview")(function* (input: SkillCopyPreviewInput) {
    const directory = yield* destination(input.directory);
    const entries = yield* Effect.forEach(input.names, (name) =>
      Effect.gen(function* () {
        const entry = path.join(directory, name);
        const exists = yield* fs.exists(entry);
        // lstat also detects dangling links, which will be replaced without following them.
        const stat = yield* fs.lstat(entry).pipe(Effect.option);
        const status =
          !exists && stat._tag === "None"
            ? ("new" as const)
            : (yield* fs.exists(path.join(entry, "SKILL.md")))
              ? ("skill" as const)
              : ("directory" as const);
        return { name, status };
      }),
    );
    return { directory, entries };
  });
  const discard = Effect.fn("SkillCopy.discard")((workKey: string) =>
    fs.remove(path.join(root, workKey), { recursive: true, force: true }),
  );
  const stage = Effect.fn("SkillCopy.stage")(
    function* (pkg: SkillCopyPackage, workKey: string) {
      const directory = path.join(root, workKey);
      yield* fs.makeDirectory(directory, { recursive: true });
      let bytes = 0;
      const seen = new Set<string>();
      for (const file of pkg.files) {
        const segments = file.path.split("/");
        if (
          segments.some((s) => !s || s === "." || s === ".." || /[\\:\0]/.test(s)) ||
          seen.has(file.path)
        )
          return yield* invalid();
        seen.add(file.path);
        const contents = yield* Effect.fromResult(Base64.decode(file.contents)).pipe(
          Effect.mapError(invalid),
        );
        bytes += contents.length;
        if (bytes > 25 * 1024 * 1024) return yield* invalid();
        const target = path.join(directory, ...segments);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFile(target, contents);
        yield* fs.chmod(target, file.mode);
      }
      const actual = yield* packages.inspect(directory);
      if (actual.name !== pkg.name || actual.digest !== pkg.digest) return yield* invalid();
      return directory;
    },
    (effect, _pkg, workKey) =>
      effect.pipe(Effect.onError(() => discard(workKey).pipe(Effect.ignore))),
  );
  const apply = Effect.fn("SkillCopy.apply")(function* (input: {
    directory: string;
    name: string;
    workKey: string;
    digest: string;
  }) {
    const directory = yield* destination(input.directory);
    const source = path.join(root, input.workKey);
    const pkg = yield* packages.inspect(source);
    if (pkg.name !== input.name || pkg.digest !== input.digest) return yield* invalid();
    yield* fs.makeDirectory(directory, { recursive: true });
    const staging = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ directory, prefix: ".t3-copy-" }),
      (location) =>
        fs.exists(path.join(location, "previous")).pipe(
          Effect.flatMap((hasBackup) =>
            hasBackup ? Effect.void : fs.remove(location, { recursive: true, force: true }),
          ),
          Effect.ignore,
        ),
    );
    const prepared = path.join(staging, "prepared");
    yield* packages.inspect(source, prepared);
    const target = path.join(directory, input.name);
    const backup = path.join(staging, "previous");
    const existing = yield* fs.lstat(target).pipe(Effect.option);
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (existing._tag === "Some") yield* fs.rename(target, backup);
        yield* fs
          .rename(prepared, target)
          .pipe(
            Effect.tapError(() =>
              existing._tag === "Some" ? fs.rename(backup, target) : Effect.void,
            ),
          );
      }),
    );
    yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore);
    return directory;
  }, Effect.scoped);
  return { exportPackage, preview, stage, apply, discard };
});
