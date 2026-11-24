import { UsageProviderKind, type UsageSummary, type UsageSummaryInput } from "@t3tools/contracts";
import { parseOpenCodeModelSlug } from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { keepsUsageRecord } from "./usageAggregation.ts";

const isUsageProvider = Schema.is(UsageProviderKind);
const decodeMixedModels = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

export const readUsageOutputThroughput = Effect.fn("UsageService.readOutputThroughput")(function* (
  input: UsageSummaryInput,
  modelAliases: ReadonlyMap<string, string>,
) {
  const start = DateTime.make(`${input.sinceDay}T00:00:00Z`);
  const lastDay = DateTime.make(`${input.untilDay}T00:00:00Z`);
  if (Option.isNone(start) || Option.isNone(lastDay)) return;
  const localMidnight = (date: DateTime.Utc) =>
    DateTime.makeZoned(date, { timeZone: input.timeZone, adjustForTimeZone: true });
  const from: Option.Option<DateTime.DateTime> =
    input.resolution === "hour" ? DateTime.make(input.sinceTime ?? "") : localMidnight(start.value);
  const until: Option.Option<DateTime.DateTime> =
    input.resolution === "hour"
      ? DateTime.make(input.untilTime ?? "")
      : localMidnight(DateTime.add(lastDay.value, { days: 1 }));
  if (Option.isNone(from) || Option.isNone(until)) return;

  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly provider: string;
    readonly model: string | null;
    readonly mixedModels: string | null;
    readonly outputTokens: number;
    readonly durationMs: number;
  }>`
      SELECT CASE COALESCE(providerThread.driver, attempt.provider)
        WHEN 'claudeAgent' THEN 'claude'
        ELSE COALESCE(providerThread.driver, attempt.provider)
        END AS provider,
        CASE
          WHEN json_array_length(turn.payload_json, '$.turnTokenUsage.models') > 1 THEN NULL
          WHEN json_array_length(turn.payload_json, '$.turnTokenUsage.models') = 1
            THEN json_extract(turn.payload_json, '$.turnTokenUsage.models[0]')
          ELSE COALESCE(json_extract(turn.payload_json, '$.model'),
            json_extract(run.payload_json, '$.executedModel'),
            json_extract(run.payload_json, '$.modelSelection.model'), '')
        END AS model,
        CASE WHEN ${input.modelFilter !== undefined ? 1 : 0}
          AND json_array_length(turn.payload_json, '$.turnTokenUsage.models') > 1
          THEN json_extract(turn.payload_json, '$.turnTokenUsage.models') END AS mixedModels,
        SUM(json_extract(turn.payload_json, '$.turnTokenUsage.outputTokens')) AS outputTokens,
        SUM(CAST(ROUND(1000 * (unixepoch(turn.completed_at, 'subsec') - unixepoch(turn.started_at, 'subsec'))) AS INTEGER)) AS durationMs
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id AND attempt.root_node_id = turn.node_id
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
      LEFT JOIN orchestration_v2_projection_provider_threads AS providerThread
        ON providerThread.provider_thread_id = turn.provider_thread_id
      WHERE turn.status = 'completed' AND run.status = 'completed'
        AND turn.completed_at >= ${DateTime.formatIso(from.value)}
        AND turn.completed_at < ${DateTime.formatIso(until.value)}
        AND turn.started_at < turn.completed_at
        AND json_extract(turn.payload_json, '$.turnTokenUsage.usageStatus') = 'complete'
        AND COALESCE(json_extract(turn.payload_json, '$.turnTokenUsage.localCommand'), 0) = 0
        AND json_extract(turn.payload_json, '$.turnTokenUsage.outputTokens') > 0
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `;
  const samples: NonNullable<UsageSummary["outputThroughput"]>[number][] = [];
  for (const row of rows) {
    if (row.durationMs <= 0 || !isUsageProvider(row.provider)) continue;
    const usageModel = (model: string) =>
      row.provider === "opencode" ? (parseOpenCodeModelSlug(model)?.modelID ?? model) : model;
    const model = usageModel(row.model?.trim() ?? "");
    if (row.mixedModels !== null) {
      const models = decodeMixedModels(row.mixedModels);
      if (
        Option.isNone(models) ||
        !models.value.every((entry) =>
          keepsUsageRecord(input.modelFilter, { provider: row.provider, model: usageModel(entry) }),
        )
      )
        continue;
    } else if (!keepsUsageRecord(input.modelFilter, { provider: row.provider, model })) {
      continue;
    }
    samples.push({
      provider: row.provider,
      ...(model === "" ? {} : { model: modelAliases.get(model) ?? model }),
      outputTokens: row.outputTokens,
      durationMs: row.durationMs,
    });
  }
  return samples.length === 0 ? undefined : samples;
});
