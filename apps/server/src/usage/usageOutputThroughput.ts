import { UsageProviderKind, type UsageSummary, type UsageSummaryInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { keepsUsageRecord } from "./usageAggregation.ts";

const isUsageProvider = Schema.is(UsageProviderKind);

export const readUsageOutputThroughput = Effect.fn("UsageService.readOutputThroughput")(function* (
  input: UsageSummaryInput,
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
    readonly model: string;
    readonly outputTokens: number;
    readonly durationMs: number;
  }>`
      SELECT CASE attempt.provider WHEN 'claudeAgent' THEN 'claude' ELSE attempt.provider END AS provider,
        COALESCE(json_extract(turn.payload_json, '$.model'),
          CASE WHEN json_array_length(turn.payload_json, '$.turnTokenUsage.models') = 1
            THEN json_extract(turn.payload_json, '$.turnTokenUsage.models[0]') END,
          json_extract(run.payload_json, '$.executedModel'),
          json_extract(run.payload_json, '$.modelSelection.model'), '') AS model,
        SUM(json_extract(turn.payload_json, '$.turnTokenUsage.outputTokens')) AS outputTokens,
        SUM(CAST(ROUND(1000 * (unixepoch(turn.completed_at, 'subsec') - unixepoch(turn.started_at, 'subsec'))) AS INTEGER)) AS durationMs
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id AND attempt.root_node_id = turn.node_id
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
      WHERE turn.status = 'completed' AND run.status = 'completed'
        AND turn.completed_at >= ${DateTime.formatIso(from.value)}
        AND turn.completed_at < ${DateTime.formatIso(until.value)}
        AND turn.started_at < turn.completed_at
        AND json_extract(turn.payload_json, '$.turnTokenUsage.usageStatus') = 'complete'
        AND COALESCE(json_extract(turn.payload_json, '$.turnTokenUsage.localCommand'), 0) = 0
        AND json_extract(turn.payload_json, '$.turnTokenUsage.outputTokens') > 0
      GROUP BY 1, 2
    `;
  const totals = new Map<UsageProviderKind, { outputTokens: number; durationMs: number }>();
  for (const row of rows) {
    if (
      row.durationMs <= 0 ||
      !isUsageProvider(row.provider) ||
      !keepsUsageRecord(input.modelFilter, row)
    )
      continue;
    const current = totals.get(row.provider) ?? { outputTokens: 0, durationMs: 0 };
    current.outputTokens += row.outputTokens;
    current.durationMs += row.durationMs;
    totals.set(row.provider, current);
  }
  if (totals.size === 0) return;
  return [...totals].map(([provider, counts]) => ({ provider, ...counts })) satisfies NonNullable<
    UsageSummary["outputThroughput"]
  >;
});
