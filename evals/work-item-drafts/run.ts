import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProjectId, ProviderInstanceId, WorkItemDraft } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import { cases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
const { out, model } = values;
const samples = Number(values.samples);
const fixtures = cases.filter((fixture) => !values.case || fixture.id === values.case);
if (!out || !model || !fixtures.length || !Number.isSafeInteger(samples) || samples < 1)
  throw new Error(
    "Use --out <directory> --model <configured model> [--case <id>] [--samples <count>].",
  );
const decodeResults = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        sample: Schema.Number,
        draft: WorkItemDraft,
      }),
    ),
  ),
);
const encodeRows = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(CodexSettings);
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-eval-" });
    const service = yield* makeCodexTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    const key = [];
    yield* fs.makeDirectory(out, { recursive: true });
    for (const fixture of fixtures) {
      for (let sample = 1; sample <= samples; sample++) {
        const previous = baseline.find((row) => row.id === fixture.id && row.sample === sample);
        if (values.baseline && !previous)
          throw new Error(`Missing baseline for ${fixture.id} sample ${sample}.`);
        const draft = yield* service.generateWorkItemDraft({
          cwd,
          projectTitle: fixture.projectTitle,
          projectId: ProjectId.make("draft-eval"),
          context: fixture.context,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
        });
        results.push({ id: fixture.id, sample, draft });
        const first = !previous || (yield* Random.nextBoolean);
        review.push({
          ...fixture,
          sample,
          A: first ? draft : previous?.draft,
          B: first ? previous?.draft : draft,
          verdict: "",
        });
        key.push({ id: fixture.id, sample, candidate: first ? "A" : "B" });
        for (const [name, rows] of [
          ["results", results],
          ["review", review],
          ["answer-key", key],
        ] as const)
          yield* fs.writeFileString(path.join(out, name + ".json"), yield* encodeRows(rows));
        yield* Effect.log(`${fixture.id} sample ${sample} recorded`);
      }
    }
    yield* fs.writeFileString(
      path.join(out, "summary.json"),
      yield* encodeRows({
        model,
        samples: results.length,
        cost: "Provider CLI does not expose billing; see provider usage.",
        grading: "Score review.json manually against each rubric.",
      }),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-draft-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
