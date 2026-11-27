const commands = new Set([
  "add",
  "cat-file",
  "check-ignore",
  "commit-tree",
  "config",
  "diff",
  "diff-tree",
  "log",
  "ls-files",
  "read-tree",
  "rev-parse",
  "sparse-checkout",
  "status",
  "update-index",
  "update-ref",
  "write-tree",
]);

export function checkpointSubcommand(args: readonly string[]) {
  let index = 0;
  while (args[index] === "-c" || args[index] === "-C" || args[index] === "--literal-pathspecs") {
    index += args[index] === "--literal-pathspecs" ? 1 : 2;
  }
  const name = args[index];
  return name && commands.has(name) ? name : "other";
}

const regions = new Set([
  "index/do_read_index",
  "index/do_write_index",
  "index/preload",
  "index/refresh",
  "index/clear_skip_worktree_from_present_files_sparse",
  "dir/read_directory",
  "cache_tree/read",
  "cache_tree/update",
  "unpack_trees/unpack_trees",
]);

export function makeCheckpointGitTrace(now: () => number) {
  const elapsed = new Map<string, number>();
  const unfinished = new Map<string, number>();
  return {
    startProcess: () => makeProcessTrace(now, elapsed, unfinished),
    summary: () => ({
      regionMs: Object.fromEntries(Array.from(elapsed, ([name, ms]) => [name, Math.round(ms)])),
      unfinishedRegionMs: Object.fromEntries(unfinished),
    }),
  };
}

function makeProcessTrace(
  now: () => number,
  elapsed: Map<string, number>,
  unfinished: Map<string, number>,
) {
  const started = now();
  const active = new Map<string, number>();
  let root: string | undefined;
  let pending = "";
  let discard = false;

  function record(line: string) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!entry || typeof entry !== "object" || !("sid" in entry) || typeof entry.sid !== "string")
      return;
    root ??= entry.sid;
    if (
      entry.sid !== root ||
      !("thread" in entry) ||
      entry.thread !== "main" ||
      !("event" in entry) ||
      !("category" in entry) ||
      typeof entry.category !== "string" ||
      !("label" in entry) ||
      typeof entry.label !== "string"
    )
      return;
    const region = `${entry.category}/${entry.label}`;
    if (!regions.has(region)) return;
    if (entry.event === "region_enter") {
      const received = now();
      const eventTime =
        "time" in entry && typeof entry.time === "string" ? Date.parse(entry.time) : NaN;
      active.set(
        region,
        Number.isFinite(eventTime) ? Math.min(received, Math.max(started, eventTime)) : received,
      );
    }
    if (entry.event === "region_leave") {
      active.delete(region);
      if (
        "t_rel" in entry &&
        typeof entry.t_rel === "number" &&
        Number.isFinite(entry.t_rel) &&
        entry.t_rel >= 0
      )
        elapsed.set(region, (elapsed.get(region) ?? 0) + entry.t_rel * 1000);
    }
  }

  return {
    onChunk(chunk: Uint8Array) {
      const lines = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        .toString("latin1")
        .split("\n");
      for (const [index, line] of lines.entries()) {
        if (pending.length + line.length > 8192) discard = true;
        if (!discard) pending += line;
        if (index === lines.length - 1) break;
        if (!discard) record(pending);
        pending = "";
        discard = false;
      }
    },
    finish() {
      const end = now();
      for (const [name, start] of active) {
        unfinished.set(name, (unfinished.get(name) ?? 0) + Math.max(0, end - start));
      }
    },
  };
}
