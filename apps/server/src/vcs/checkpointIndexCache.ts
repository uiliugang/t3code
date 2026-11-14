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
  operation: Schema.Literals(["load", "prepare", "remember"]),
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
    (target: string, root: string, timestamp: number) =>
      Effect.tryPromise({
        try: async (signal) => {
          const parsed = parseIndex(await NodeFSP.readFile(target));
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
          return invalidateChangedIndexStats(parsed, stats, timestamp);
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
  return { load, prepare, remember };
}
