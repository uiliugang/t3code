// @effect-diagnostics nodeBuiltinImport:off - Nanosecond ctimes are required to validate cached Git stat data.
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { indexEntryStat, invalidateChangedIndexStats, parseIndex } from "./gitIndexStat.ts";

const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_CACHED_INDEXES = 16;

class CheckpointIndexCacheError extends Schema.TaggedError<
  CheckpointIndexCacheError,
  { readonly brand: unique symbol }
>()("CheckpointIndexCacheError", {
  operation: Schema.Literals(["load", "prepare", "remember", "checkStat"]),
  cause: Schema.Defect(),
}) {}

interface CachedIndex {
  readonly source: string;
  readonly head: string;
  readonly bytes: Uint8Array;
  readonly timestamp: number;
}

interface IndexSeed {
  readonly indexPath: string;
  readonly source: string;
  readonly head: string;
  readonly previous: CachedIndex | undefined;
  readonly cached: CachedIndex | undefined;
}

const fingerprint = (stat: NodeFS.BigIntStats) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function makeCheckpointIndexCache() {
  const entries = new Map<string, CachedIndex>();
  const load = Effect.fn("CheckpointIndexCache.load")((indexPath: string, head: string) =>
    Effect.tryPromise({
      try: async (): Promise<IndexSeed | undefined> => {
        const stat = await NodeFSP.stat(indexPath, { bigint: true });
        if (stat.size > MAX_INDEX_BYTES) return undefined;
        const source = fingerprint(stat);
        const previous = entries.get(indexPath);
        const cached = previous?.source === source && previous.head === head ? previous : undefined;
        if (!cached) {
          const bytes = await NodeFSP.readFile(indexPath);
          if (!parseIndex(bytes)) return undefined;
          if (fingerprint(await NodeFSP.stat(indexPath, { bigint: true })) !== source)
            return undefined;
        }
        return { indexPath, source, head, previous, cached };
      },
      catch: (cause) => new CheckpointIndexCacheError({ operation: "load", cause }),
    }).pipe(Effect.orElseSucceed(() => undefined)),
  );
  const prepare = Effect.fn("CheckpointIndexCache.prepare")(
    (
      target: string,
      root: string,
      timestamp: number,
      options?: { readonly ignoreFileMode?: boolean },
    ) =>
      Effect.tryPromise({
        try: async (signal) => {
          const parsed = parseIndex(await NodeFSP.readFile(target), { allowVersion4: true });
          if (!parsed) return null;
          const stats = [];
          for (let start = 0; start < parsed.entries.length; start += 32) {
            if (signal.aborted) return null;
            stats.push(
              ...(await Promise.all(
                parsed.entries
                  .slice(start, start + 32)
                  .map((entry) =>
                    NodeFSP.lstat(`${root}/${entry.path}`, { bigint: true }).then(
                      indexEntryStat,
                      () => undefined,
                    ),
                  ),
              )),
            );
          }
          return invalidateChangedIndexStats(parsed, stats, timestamp, options);
        },
        catch: (cause) => new CheckpointIndexCacheError({ operation: "prepare", cause }),
      }).pipe(
        Effect.flatMap((bytes) =>
          bytes === null
            ? Effect.succeed(false)
            : Effect.tryPromise({
                try: () => NodeFSP.writeFile(target, bytes),
                catch: (cause) => new CheckpointIndexCacheError({ operation: "prepare", cause }),
              }).pipe(
                Effect.as(true),
                // Finish writes before capture interruption removes the private index.
                Effect.uninterruptible,
              ),
        ),
        Effect.orElseSucceed(() => false),
      ),
  );
  // A difference can skip the clean probe. Matching stats still need Git's content and path checks.
  const worktreeStatsMatch = Effect.fn("CheckpointIndexCache.worktreeStatsMatch")(
    (indexPath: string, root: string) =>
      Effect.tryPromise({
        try: async (signal) => {
          if ((await NodeFSP.stat(indexPath)).size > 16 * MAX_INDEX_BYTES) return false;
          const parsed = parseIndex(await NodeFSP.readFile(indexPath, { signal }), {
            allowVersion4: true,
            allowSparse: true,
          });
          if (!parsed) return false;
          const view = new DataView(
            parsed.bytes.buffer,
            parsed.bytes.byteOffset,
            parsed.bytes.byteLength,
          );
          const tracked = parsed.entries.filter(
            (entry) => !entry.skipWorktree && view.getUint32(entry.offset + 24) !== 0o160000,
          );
          for (let start = 0; start < tracked.length; start += 64) {
            if (signal.aborted) return false;
            const matches = await Promise.all(
              tracked.slice(start, start + 64).map(async (entry) => {
                if (
                  entry.path.includes("�") ||
                  entry.path.includes("\\") ||
                  entry.path.split("/").some((part) => part === "" || part === "." || part === "..")
                )
                  return false;
                const stat = indexEntryStat(
                  await NodeFSP.lstat(`${root}/${entry.path}`, { bigint: true }),
                );
                return (
                  view.getUint32(entry.offset) === stat.ctimeSeconds &&
                  view.getUint32(entry.offset + 4) === stat.ctimeNanoseconds &&
                  view.getUint32(entry.offset + 8) === stat.mtimeSeconds &&
                  view.getUint32(entry.offset + 12) === stat.mtimeNanoseconds &&
                  view.getUint32(entry.offset + 36) === stat.size
                );
              }),
            );
            if (matches.includes(false)) return false;
          }
          return true;
        },
        catch: (cause) => new CheckpointIndexCacheError({ operation: "checkStat", cause }),
      }).pipe(Effect.orElseSucceed(() => false)),
  );
  const remember = Effect.fn("CheckpointIndexCache.remember")((seed: IndexSeed, target: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        const stat = await NodeFSP.stat(target, { bigint: true });
        if (stat.size > MAX_INDEX_BYTES) return;
        const bytes = await NodeFSP.readFile(target);
        if (!parseIndex(bytes)) return;
        const source = fingerprint(await NodeFSP.stat(seed.indexPath, { bigint: true }));
        // An older capture cannot replace a cache published by another capture.
        if (
          signal.aborted ||
          source !== seed.source ||
          entries.get(seed.indexPath) !== seed.previous
        )
          return;
        entries.delete(seed.indexPath);
        while (entries.size >= MAX_CACHED_INDEXES) entries.delete(entries.keys().next().value!);
        entries.set(seed.indexPath, {
          source,
          head: seed.head,
          bytes,
          timestamp: Number((stat.mtimeNs - 1_000_000n) / 1_000_000_000n),
        });
      },
      catch: (cause) => new CheckpointIndexCacheError({ operation: "remember", cause }),
    }).pipe(Effect.ignore),
  );
  return { load, prepare, remember, worktreeStatsMatch };
}
