import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

it.effect("rejects malformed drafts and retains structured editable criteria", () =>
  Effect.gen(function* () {
    const input = {
      cwd: "/repo",
      projectId: ProjectId.make("project"),
      projectTitle: "Project",
      context: "Improve search",
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "test" },
    };
    const generate = (text: string) =>
      fromRunner("Stub", (request) => decodeJsonReply(request, "Stub", text)).generateWorkItemDraft(
        input,
      );
    const valid = {
      title: "Improve search",
      description: "Find matching items",
      constraints: [],
      acceptanceCriteria: ["An empty query shows all items"],
    };
    assert.deepEqual(yield* generate(JSON.stringify(valid)), valid);
    assert.instanceOf(
      yield* generate(JSON.stringify({ ...valid, acceptanceCriteria: "passed" })).pipe(Effect.flip),
      TextGenerationError,
    );
  }),
);

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);
