// @effect-diagnostics nodeBuiltinImport:off - Workflow tests execute checked-in shell and expressions.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

const decodeWorkflow = Schema.decodeUnknownSync(
  fromYaml(
    Schema.Struct({
      on: Schema.Record(Schema.String, Schema.Unknown),
      concurrency: Schema.Struct({ group: Schema.String, "cancel-in-progress": Schema.String }),
      jobs: Schema.Struct({
        prepare: Schema.Struct({
          steps: Schema.Array(
            Schema.Struct({
              if: Schema.optional(Schema.String),
              run: Schema.optional(Schema.String),
            }),
          ),
        }),
        android: Schema.Struct({
          needs: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        }),
        macos: Schema.Struct({
          if: Schema.String,
          env: Schema.Record(Schema.String, Schema.String),
        }),
        linux: Schema.Struct({ if: Schema.String }),
        publish: Schema.Struct({ if: Schema.String }),
      }),
    }),
  ),
);

const readWorkflow = () =>
  decodeWorkflow(
    NodeFS.readFileSync(new URL("../.github/workflows/fork-release.yml", import.meta.url), "utf8"),
  );

const context = (
  event: string,
  ref: string,
  inputs = { android_only: false, verify_cache: false },
) => ({
  github: { event_name: event, ref, ref_type: ref.startsWith("refs/tags/") ? "tag" : "branch" },
  inputs,
});

// These expressions use equality and boolean operators shared with JavaScript.
const evaluate = (expression: string, input: ReturnType<typeof context>): unknown =>
  NodeVM.runInNewContext(expression.replace(/^\$\{\{|\}\}$/g, "").trim(), input);

it("waits before checkout only for automatic main warmups and preserves release routing", () => {
  const workflow = readWorkflow();
  const debounce = workflow.jobs.prepare.steps[0];
  if (!debounce?.if || !debounce.run) throw new Error("Expected a guarded wait before checkout.");

  for (const [input, waits, desktop, publishes] of [
    [context("push", "refs/heads/main"), true, false, false],
    [context("push", "refs/tags/v1.2.3"), false, true, true],
    [context("workflow_dispatch", "refs/heads/main"), false, true, false],
    [context("workflow_dispatch", "refs/tags/v1.2.3"), false, true, true],
    [
      context("workflow_dispatch", "refs/heads/main", { android_only: true, verify_cache: false }),
      false,
      false,
      false,
    ],
    [
      context("workflow_dispatch", "refs/heads/main", { android_only: false, verify_cache: true }),
      false,
      false,
      false,
    ],
  ] as const) {
    assert.equal(evaluate(debounce.if, input), waits);
    assert.equal(evaluate(workflow.jobs.macos.if, input), desktop);
    assert.equal(evaluate(workflow.jobs.linux.if, input), desktop);
    assert.equal(evaluate(workflow.jobs.publish.if, input), publishes);
  }

  const wait = NodeChildProcess.spawnSync(
    "bash",
    ["-c", 'sleep() { printf "wait:%s\\n" "$*"; };\n' + debounce.run],
    { encoding: "utf8" },
  );
  assert.ifError(wait.error);
  assert.equal(wait.status, 0, wait.stderr);
  assert.equal(wait.stdout, "wait:300\n");
  const dependencies = workflow.jobs.android.needs;
  assert.include(typeof dependencies === "string" ? [dependencies] : dependencies, "prepare");
  assert.notProperty(workflow.on, "pull_request");
});

it("selects a macOS SDK that provides the native Apple Speech APIs", () => {
  assert.match(readWorkflow().jobs.macos.env.DEVELOPER_DIR ?? "", /Xcode_26\./u);
});

it("replaces earlier main warmups without cancelling tag releases or manual cache checks", () => {
  const { concurrency } = readWorkflow();
  const group = (input: ReturnType<typeof context>) =>
    concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
      String(evaluate(expression, input)),
    );
  const first = context("push", "refs/heads/main");
  const warmupGroup = group(first);
  for (const sha of ["first-merge", "second-merge", "last-merge"]) {
    const input = { ...first, github: { ...first.github, sha } };
    assert.equal(group(input), warmupGroup);
    assert.equal(evaluate(concurrency["cancel-in-progress"], input), true);
  }
  const tag = context("push", "refs/tags/v1.2.3");
  assert.notEqual(group(tag), warmupGroup);
  assert.equal(evaluate(concurrency["cancel-in-progress"], tag), false);
  for (const inputs of [
    { android_only: false, verify_cache: false },
    { android_only: true, verify_cache: false },
    { android_only: false, verify_cache: true },
  ]) {
    assert.notEqual(group(context("workflow_dispatch", "refs/heads/main", inputs)), warmupGroup);
  }
});
