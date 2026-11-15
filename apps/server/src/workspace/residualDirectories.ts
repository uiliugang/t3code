import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export const residualDirectoryPaths = Effect.fn("ManagedWorktrees.residualDirectoryPaths")(
  function* (roots: ReadonlyArray<string>, scratch: string, known: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found = new Set(known);
    const directories = Effect.fn("ManagedWorktrees.residualChildren")(function* (root: string) {
      const names = yield* fs
        .readDirectory(root)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
      return yield* Effect.filter(
        names.map((name) => path.join(root, name)),
        (target) => fs.lstat(target).pipe(Effect.map((stat) => stat.type === "Directory")),
      );
    });
    for (const root of roots) {
      for (const folder of yield* directories(root)) {
        if (known.includes(folder) || (yield* fs.exists(path.join(folder, ".git")))) {
          found.add(folder);
          continue;
        }
        const children = yield* directories(folder);
        if (children.length === 0 || (yield* fs.readDirectory(folder)).length > children.length)
          found.add(folder);
        else for (const child of children) found.add(child);
      }
    }
    for (const folder of yield* directories(scratch)) found.add(folder);
    return [...found].sort();
  },
);

export const residualDirectoryBytes = Effect.fn("ManagedWorktrees.residualDirectoryBytes")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pending = [root];
    let bytes = 0;
    let count = 0;
    while (pending.length > 0) {
      const target = pending.pop()!;
      const stat = yield* fs.lstat(target);
      if (++count > 2_000_000) return null;
      if (stat.type === "SymbolicLink") continue;
      if (stat.type === "Directory") {
        if ((yield* fs.realPath(target)) !== target) return null;
        for (const name of yield* fs.readDirectory(target)) pending.push(path.join(target, name));
      } else if (stat.type === "File") {
        bytes += Option.match(stat.blocks, {
          onNone: () => Number(stat.size),
          onSome: (blocks) => Number(blocks * 512n),
        });
      }
    }
    return bytes;
  },
  Effect.timeout("3 seconds"),
  Effect.orElseSucceed(() => null),
);
