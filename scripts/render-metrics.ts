// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - wrapper around the renders vitest project.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { vitePlusCommand } from "./check-changed-command.ts";
import { resolveGitCommonDir, withBrowserTestLock } from "./check-changed-lock.ts";

const HELP = `Usage:
  node scripts/render-metrics.ts run [--out <file>] [--runs <n>]
  node scripts/render-metrics.ts compare <before.json> <after.json> [--top <n>]

run      Runs the web render scenarios (apps/web/test/renderScenarios.renders.tsx,
         vitest project "renders") on this checkout and writes one JSON object of
         { scenario: { commits, renders, components } }. With --runs above 1 (default 3)
         it fails unless every run produced identical counts.
compare  Prints a markdown table of commit and render deltas per scenario, plus the
         components whose counts changed most (default top 10).

commits are React commits that rendered at least one component (null where frame
timing splits them); renders are function and class component renders, counted from the
fibers React worked on. Every scenario waits for the tree to go quiet before and after
its counted window, so layout follow-ups are included.

Comparing two refs needs both checkouts, since the scenarios run each tree's code:
  node scripts/render-metrics.ts run --out ../main-renders.json        # on main
  node scripts/render-metrics.ts run --out ../branch-renders.json      # on the branch
  node scripts/render-metrics.ts compare ../main-renders.json ../branch-renders.json
A second checkout comes from \`git worktree add ../<name> main\`; copy the harness files
in if that tree predates them.`;

const ScenarioReportSchema = Schema.Struct({
  commits: Schema.NullOr(Schema.Number),
  renders: Schema.Number,
  components: Schema.Record(Schema.String, Schema.Number),
});
const decodeScenarioReport = Schema.decodeEffect(Schema.fromJsonString(ScenarioReportSchema));

export interface ScenarioReport {
  /** null where a scenario's commit count depends on frame timing. */
  readonly commits: number | null;
  readonly renders: number;
  readonly components: Readonly<Record<string, number>>;
}
export type RenderMetrics = Readonly<Record<string, ScenarioReport>>;

const root = NodePath.resolve(import.meta.dirname, "..");

export const runOnce = Effect.fn("renderMetrics.runOnce")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-renders-" });
      const [command, commandArgs] = vitePlusCommand(
        ["test", "run", "--project", "renders"],
        platform,
      );
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, commandArgs, {
          cwd: path.join(root, "apps/web"),
          env: { T3CODE_RENDER_REPORT_DIR: directory },
          extendEnv: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          forceKillAfter: "5 seconds",
        }),
      );
      const exitCode = Number(yield* handle.exitCode);
      if (exitCode !== 0) {
        return yield* Effect.fail(`render scenarios failed (exit ${exitCode})`);
      }
      const files = (yield* fs.readDirectory(directory))
        .filter((file) => file.endsWith(".json"))
        .toSorted();
      const entries = yield* Effect.forEach(files, (file) =>
        fs.readFileString(path.join(directory, file)).pipe(
          Effect.flatMap(decodeScenarioReport),
          Effect.map((report) => [file.replace(/\.json$/, ""), report] as const),
        ),
      );
      return Object.fromEntries(entries) as RenderMetrics;
    }),
  );
});

/** Scenarios whose counts differ between runs, by name. */
export function nondeterministic(runs: ReadonlyArray<RenderMetrics>): string[] {
  const [first, ...rest] = runs;
  if (!first) return [];
  return Object.keys(first).filter((scenario) =>
    rest.some((run) => JSON.stringify(run[scenario]) !== JSON.stringify(first[scenario])),
  );
}

const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`);
const change = (before: number | null, after: number | null) =>
  before === null || after === null
    ? "n/a"
    : before === after
      ? `${after}`
      : `${before} → ${after} (${signed(after - before)}${before ? `, ${signed(Math.round(((after - before) / before) * 100))}%` : ""})`;

export function renderComparison(before: RenderMetrics, after: RenderMetrics, top = 10): string {
  const scenarios = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  const lines = [
    "### Render scenarios",
    "",
    "| scenario | commits | renders |",
    "| :-- | --: | --: |",
  ];
  const empty: ScenarioReport = { commits: 0, renders: 0, components: {} };
  for (const scenario of scenarios) {
    const a = before[scenario] ?? empty;
    const b = after[scenario] ?? empty;
    lines.push(
      `| ${scenario} | ${change(a.commits, b.commits)} | ${change(a.renders, b.renders)} |`,
    );
  }
  for (const scenario of scenarios) {
    const a = before[scenario]?.components ?? {};
    const b = after[scenario]?.components ?? {};
    const moved = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .map((name) => [name, a[name] ?? 0, b[name] ?? 0] as const)
      .filter(([, x, y]) => x !== y)
      .sort(([n, x, y], [m, p, q]) => Math.abs(q - p) - Math.abs(y - x) || n.localeCompare(m))
      .slice(0, top);
    if (moved.length === 0) continue;
    lines.push("", `<details><summary>${scenario}: components that changed most</summary>`, "");
    lines.push("| component | renders |", "| :-- | --: |");
    for (const [name, x, y] of moved) lines.push(`| \`${name}\` | ${change(x, y)} |`);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}

function option(
  args: ReadonlyArray<string>,
  name: string,
): {
  readonly present: boolean;
  readonly value: string | undefined;
} {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === name) {
      return { present: true, value: args[index + 1] };
    }
    if (arg.startsWith(`${name}=`)) {
      return { present: true, value: arg.slice(name.length + 1) };
    }
  }
  return { present: false, value: undefined };
}

export function parseRunOptions(args: ReadonlyArray<string>): {
  readonly runs: number;
  readonly out: string | undefined;
} {
  const runsOpt = option(args, "--runs");
  const runs = !runsOpt.present ? 3 : Number(runsOpt.value);
  if (!Number.isSafeInteger(runs) || runs < 1 || runsOpt.value === "") {
    throw new RangeError("report:renders: --runs must be a positive integer.");
  }
  const outOpt = option(args, "--out");
  if (outOpt.present && (!outOpt.value || outOpt.value.startsWith("-"))) {
    throw new RangeError("report:renders: --out requires a file path.");
  }
  return { runs, out: outOpt.value };
}

function reportResults(
  results: ReadonlyArray<RenderMetrics>,
  runs: number,
  out: string | undefined,
): void {
  const unstable = nondeterministic(results);
  if (unstable.length) {
    for (const scenario of unstable) {
      const counts = results.map((run) => `${run[scenario]?.commits}/${run[scenario]?.renders}`);
      console.error(`${scenario} differed between runs (commits/renders): ${counts.join(", ")}`);
      const first = results[0]?.[scenario]?.components ?? {};
      for (const [index, run] of results.entries()) {
        const other = run[scenario]?.components ?? {};
        const names = [...new Set([...Object.keys(first), ...Object.keys(other)])];
        const moved = names.filter((name) => first[name] !== other[name]);
        if (moved.length) {
          const detail = moved.map((name) => `${name} ${first[name] ?? 0}→${other[name] ?? 0}`);
          console.error(`  run ${index + 1} vs run 1: ${detail.join(", ")}`);
        }
      }
    }
    process.exitCode = 1;
  } else {
    const json = JSON.stringify(results[0], null, 2);
    if (out) NodeFS.writeFileSync(out, json + "\n");
    else console.log(json);
    console.error(`${runs} run(s) produced identical counts.`);
  }
}

if (import.meta.main) {
  const cliArgs = process.argv[2] === "--" ? process.argv.slice(3) : process.argv.slice(2);
  const [command, ...args] = cliArgs;
  if (command === "run") {
    Effect.gen(function* () {
      const { runs, out } = yield* Effect.try({
        try: () => parseRunOptions(args),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      });
      const commonDir = yield* resolveGitCommonDir(root, "report:renders");
      const results = yield* withBrowserTestLock(
        commonDir,
        Effect.forEach(Array.from({ length: runs }), () => runOnce()),
        {
          waitingMessage:
            "report:renders: waiting for another browser test in this repository to finish.",
        },
      );
      yield* Effect.sync(() => reportResults(results, runs, out));
    }).pipe(
      Effect.catch((error) =>
        Console.error(String(error)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
      Effect.provide(NodeServices.layer),
      NodeRuntime.runMain,
    );
  } else if (command === "compare" && args[0] && args[1]) {
    const read = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8")) as RenderMetrics;
    const topOpt = option(args, "--top");
    const top = !topOpt.present ? 10 : Number(topOpt.value);
    if (!Number.isSafeInteger(top) || top < 1 || topOpt.value === "") {
      console.error("report:renders: --top must be a positive integer.");
      process.exitCode = 1;
    } else {
      console.log(renderComparison(read(args[0]), read(args[1]), top));
    }
  } else {
    console.log(HELP);
    if (command !== "--help" && command !== "-h" && command !== undefined) process.exitCode = 1;
  }
}
