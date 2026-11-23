// @effect-diagnostics nodeBuiltinImport:off - tests verify temp directory cleanup on the real filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import { nondeterministic, parseRunOptions, renderComparison, runOnce } from "./render-metrics.ts";

const mountReport = { commits: 2, renders: 10, components: { Row: 10 } };

describe("runOnce", () => {
  it.effect(
    "collects the scenario reports when HOME has no .cache, then removes its report dir",
    () =>
      Effect.gen(function* () {
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-render-metrics-"));
        vi.stubEnv("HOME", home);
        vi.stubEnv("TMPDIR", home);
        vi.stubEnv("USERPROFILE", home);
        vi.stubEnv("TEMP", home);
        vi.stubEnv("TMP", home);

        const spawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) {
            return Effect.die("expected standard command");
          }
          const reportDir = String(command.options.env?.T3CODE_RENDER_REPORT_DIR ?? "");
          NodeFS.writeFileSync(NodePath.join(reportDir, "mount.json"), JSON.stringify(mountReport));
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(100),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });

        return yield* runOnce().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.tap((metrics) =>
            Effect.sync(() => {
              expect(metrics).toEqual({ mount: mountReport });
              expect(NodeFS.readdirSync(home)).toEqual([]);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              vi.unstubAllEnvs();
              NodeFS.rmSync(home, { recursive: true, force: true });
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("parseRunOptions", () => {
  it("validates --runs and --out arguments", () => {
    expect(parseRunOptions([])).toEqual({ runs: 3, out: undefined });
    expect(parseRunOptions(["--runs", "2", "--out", "metrics.json"])).toEqual({
      runs: 2,
      out: "metrics.json",
    });
    expect(parseRunOptions(["--runs=4", "--out=out.json"])).toEqual({
      runs: 4,
      out: "out.json",
    });
    for (const invalid of [
      ["--runs", "0"],
      ["--runs=0"],
      ["--runs="],
      ["--runs", "-1"],
      ["--runs", "1.5"],
      ["--runs", "abc"],
      ["--out"],
      ["--out="],
      ["--out", "--runs"],
    ]) {
      expect(() => parseRunOptions(invalid)).toThrow();
    }
  });
});

describe("nondeterministic", () => {
  it("names only the scenarios whose counts differ between runs", () => {
    const stable = { commits: 2, renders: 10, components: { Row: 10 } };
    expect(
      nondeterministic([
        { mount: stable, type: { commits: 1, renders: 4, components: { Editor: 4 } } },
        { mount: stable, type: { commits: 1, renders: 5, components: { Editor: 5 } } },
      ]),
    ).toEqual(["type"]);
  });
});

describe("renderComparison", () => {
  it("prints per-scenario deltas and the components that moved most", () => {
    const output = renderComparison(
      { stream: { commits: 40, renders: 400, components: { Row: 300, Header: 100 } } },
      { stream: { commits: 30, renders: 250, components: { Row: 150, Header: 100 } } },
    );
    expect(output).toContain("| stream | 40 → 30 (-10, -25%) | 400 → 250 (-150, -37%) |");
    expect(output).toContain("| `Row` | 300 → 150 (-150, -50%) |");
    expect(output).not.toContain("`Header`");
  });
});
