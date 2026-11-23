import { IssueTrackerKind } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { listLinkedIssueThreads } from "./linkedThreads.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("finds every thread linked to exactly one issue, newest activity first", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = (day: number) => `2026-11-0${day}T00:00:00.000Z`;
    const issue = { tracker: "linear", host: "linear.app", scope: "eng", key: "ENG-7" };
    const fixtures = [
      { id: "older", day: 1, issues: [issue] },
      { id: "newer", day: 2, issues: [{ ...issue, key: "ENG-8" }, issue] },
      { id: "settled", day: 3, issues: [issue], payload: { settledOverride: "settled" } },
      { id: "archived", day: 4, issues: [issue], archived: true },
      { id: "deleted", day: 5, issues: [issue], deleted: true },
      { id: "side-chat", day: 5, issues: [issue], payload: { lineage: { sideChat: true } } },
      { id: "other-key", day: 5, issues: [{ ...issue, key: "ENG-70" }] },
      { id: "other-scope", day: 5, issues: [{ ...issue, scope: "design" }] },
      { id: "other-tracker", day: 5, issues: [{ ...issue, tracker: "github" }] },
      { id: "unlinked", day: 5, issues: [] },
    ];
    for (const fixture of fixtures) {
      const payload = yield* encodePayload({ ...fixture.payload, issues: fixture.issues });
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${fixture.id}, 'project-1', ${fixture.id}, 'codex', 'full-access', 'default',
          ${at(1)}, ${at(fixture.day)}, ${fixture.archived ? at(fixture.day) : null},
          ${fixture.deleted ? at(fixture.day) : null}, ${payload}
        )
      `;
    }

    const result = yield* listLinkedIssueThreads({
      tracker: IssueTrackerKind.make("linear"),
      host: "Linear.app",
      scope: "ENG",
      key: "ENG-7",
    });
    expect(result.threads.map((thread) => [thread.id, thread.settled, thread.archivedAt])).toEqual([
      ["archived", false, at(4)],
      ["settled", true, null],
      ["newer", false, null],
      ["older", false, null],
    ]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps linked threads apart across Linear workspaces that share a team key", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-11-01T00:00:00.000Z";
    const acme = {
      tracker: "linear",
      host: "linear.app",
      scope: "ENG",
      key: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1/login",
    };
    const globex = { ...acme, url: "https://linear.app/globex/issue/ENG-1/login" };
    for (const [id, issues] of [
      ["acme-thread", [acme]],
      ["globex-thread", [globex]],
      ["both-thread", [acme, globex]],
    ] as const) {
      const payload = yield* encodePayload({ issues });
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${id}, 'project-1', ${id}, 'codex', 'full-access', 'default',
          ${at}, ${at}, NULL, NULL, ${payload}
        )
      `;
    }

    const acmeThreads = yield* listLinkedIssueThreads({
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "ENG",
      key: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1",
    });
    const globexThreads = yield* listLinkedIssueThreads({
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "ENG",
      key: "ENG-1",
      url: "https://linear.app/globex/issue/ENG-1",
    });
    expect(acmeThreads.threads.map((thread) => thread.id)).toEqual(["acme-thread", "both-thread"]);
    expect(globexThreads.threads.map((thread) => thread.id)).toEqual([
      "both-thread",
      "globex-thread",
    ]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
