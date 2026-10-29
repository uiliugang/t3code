#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import * as ProcessRunner from "../../apps/server/src/processRunner.ts";
import { cases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    "codex-binary": { type: "string" },
  },
});
if (!values.model || !values.out) throw new Error("Use --model <model> --out <directory>.");
const model = values.model;
const out = values.out;
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1)
  throw new Error("--samples must be a positive integer.");
const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prediction-eval-" });
    const generator = yield* CodexTextGeneration.makeCodexTextGeneration(
      yield* decodeSettings({
        binaryPath: values["codex-binary"] ?? "codex",
      }),
    );
    const results = [];
    for (const fixture of cases.filter((entry) => !values.case || values.case.includes(entry.id))) {
      for (let sample = 0; sample < samples; sample++) {
        const result = yield* generator.generatePredictedMessage({
          cwd,
          messages: fixture.messages,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
        });
        results.push({
          id: fixture.id,
          sample,
          source: fixture.source,
          model,
          text: result.text,
          rubric: fixture.rubric,
        });
      }
    }
    yield* fs.makeDirectory(out, { recursive: true });
    yield* fs.writeFileString(path.join(out, "results.json"), yield* encode(results));
    yield* Effect.log(
      `Wrote ${results.length} prediction samples to ${out}/results.json. Review each output against its rubric; the model's provider usage applies.`,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ProcessRunner.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-prediction-eval-state-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
