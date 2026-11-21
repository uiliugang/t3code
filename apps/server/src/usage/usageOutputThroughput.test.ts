import { UsageDay } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { readUsageOutputThroughput } from "./usageOutputThroughput.ts";

it.effect("aggregates only measured root turns in the selected window and models", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run', 'thread', 1, 'codex', 'completed', '2026-11-01T06:59:00.000Z', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_run_attempts
        (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
      VALUES ('attempt', 'thread', 'run', 1, 'root', 'codex', 'provider-thread', 'completed', '{}')
    `;
    const complete = { usageStatus: "complete", outputTokens: 100 };
    const previous = "2026-11-01T06:59:59.999Z";
    const opening = "2026-11-01T07:00:00.000Z";
    const closing = "2026-11-02T08:00:00.000Z";
    for (const [index, [completedAt, startedAt, model, usage, node]] of [
      [
        opening,
        "2026-11-01T06:59:59.500Z",
        "fast-alias",
        { ...complete, models: ["fast"] },
        "root",
      ],
      [
        opening,
        "2026-11-01T06:59:59.000Z",
        "slow",
        { ...complete, models: ["fast", "slow"] },
        "root",
      ],
      ["2026-11-02T07:59:59.999Z", "2026-11-02T07:59:57.999Z", "slow", complete, "root"],
      [previous, "2026-11-01T06:59:00.000Z", "fast", complete, "root"],
      [closing, "2026-11-02T07:59:30.000Z", "fast", complete, "root"],
      [opening, previous, "fast", { ...complete, usageStatus: "partial" }, "root"],
      [opening, previous, "fast", { ...complete, localCommand: true }, "root"],
      [opening, previous, "fast", complete, "child"],
      [opening, opening, "fast", complete, "root"],
    ].entries()) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_turns
          (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal,
           status, started_at, completed_at, payload_json)
        VALUES (${`turn-${index}`}, 'thread', 'provider-thread', ${node}, 'attempt', ${index + 1},
          'completed', ${startedAt}, ${completedAt}, ${JSON.stringify({ model, turnTokenUsage: usage })})
      `;
    }
    const day = UsageDay.make("2026-11-01");
    const input = { sinceDay: day, untilDay: day, timeZone: "America/Los_Angeles" };
    const aliases = new Map([["slow", "slow-alias"]]);
    assert.deepStrictEqual(yield* readUsageOutputThroughput(input, aliases), [
      { provider: "codex", outputTokens: 100, durationMs: 1000 },
      { provider: "codex", model: "fast", outputTokens: 100, durationMs: 500 },
      { provider: "codex", model: "slow-alias", outputTokens: 100, durationMs: 2000 },
    ]);
    assert.deepStrictEqual(
      yield* readUsageOutputThroughput(
        { ...input, modelFilter: { exclude: [{ model: "unrelated" }] } },
        aliases,
      ),
      [
        { provider: "codex", outputTokens: 100, durationMs: 1000 },
        { provider: "codex", model: "fast", outputTokens: 100, durationMs: 500 },
        { provider: "codex", model: "slow-alias", outputTokens: 100, durationMs: 2000 },
      ],
    );
    assert.deepStrictEqual(
      yield* readUsageOutputThroughput(
        {
          ...input,
          modelFilter: { include: [{ provider: "codex", model: "slow" }] },
        },
        aliases,
      ),
      [{ provider: "codex", model: "slow-alias", outputTokens: 100, durationMs: 2000 }],
    );
    assert.deepStrictEqual(
      yield* readUsageOutputThroughput(
        {
          ...input,
          resolution: "hour",
          sinceTime: opening,
          untilTime: "2026-11-01T08:00:00.000Z",
        },
        aliases,
      ),
      [
        { provider: "codex", outputTokens: 100, durationMs: 1000 },
        { provider: "codex", model: "fast", outputTokens: 100, durationMs: 500 },
      ],
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
