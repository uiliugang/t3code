import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SqlMessageStorage, SqlRunnerStorage } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  dropResumableFamilies,
  runMigrateDevDb,
  splitPathParentAndLeaf,
} from "./migrate-dev-db.ts";

const withDatabase = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const insertPeerLink = (sql: SqlClient.SqlClient) => sql`INSERT INTO peer_environment_links
  (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
  VALUES ('environment-box', 'peer-link-box', 'Box', '["https://box.example"]', 'auto',
    '2026-08-01', '2027-08-01')`;

const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
  toMigrationInclusive?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive });

      const scripts = JSON.stringify([
        { id: "lint", name: "Lint", command: "vp lint", icon: "lint", runOnWorktreeCreate: false },
        {
          id: "teardown",
          name: "Teardown",
          command: "./teardown",
          icon: "configure",
          runOnWorktreeCreate: false,
          runOnSettle: true,
        },
      ]);
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', ${scripts}, '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      const watchedPayload = JSON.stringify({
        pullRequests: [
          {
            host: "github.com",
            repository: "owner/repo",
            number: 7,
            url: "https://github.com/owner/repo/pull/7",
            source: "agent",
            linkedAt: "2026-08-01T00:00:00.000Z",
            snapshot: null,
            stack: null,
            watch: {
              startedAt: "2026-08-01T00:00:00.000Z",
              headSha: null,
              failedChecks: [],
              passed: false,
              passedChecks: [],
              remarksThrough: "2026-08-01T00:00:00.000Z",
              remarkIds: [],
              conflicting: false,
              wakes: 0,
            },
          },
        ],
      });
      const threads = [
        ["stopped-thread", "project-kept", "completed", watchedPayload, "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "archived-thread",
          "project-kept",
          "completed",
          '{"archivedAt":"2026-08-01"}',
          "2026-08-05",
        ],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
        // Finished, but startup recovery would deliver its unread steer and start a turn.
        ["steer-thread", "project-kept", "completed", "{}", "2026-08-09"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}', 2)`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
        VALUES ('steer-item', 'steer-thread', 'run-steer-thread', 2, 'user_message', 'pending',
          '2026-08-09', '{"inputIntent":"steer"}')`;
      // A V1 thread the server already imported must not trip the legacy guard.
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
        VALUES ('stopped-thread', 'project-kept', 'stopped-thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-08-01', '2026-08-01')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'archived-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO scheduled_task_webhook_replay_keys
        (task_id, replay_key, delivery_id, expires_at)
        VALUES ('task-1', 'replay-1', 'delivery-1', 1900000000000)`;
      yield* sql`INSERT INTO scheduled_task_webhook_pending
        (delivery_id, task_id, coalesce_key, due_at, task_json, request_json, delivery_ids_json)
        VALUES ('delivery-1', 'task-1', 'key-1', 1900000000000, '{}', '{}', '[]')`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
      if (toMigrationInclusive === undefined || toMigrationInclusive >= 70) {
        yield* sql`INSERT INTO peer_environment_links
        (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
        VALUES ('environment-box', 'peer-link-box', 'Box', '["https://box.example"]', 'auto',
          '2026-08-01', '2027-08-01')`;
      }
      if (toMigrationInclusive === undefined || toMigrationInclusive >= 87) {
        yield* sql`INSERT INTO wechat_connection (id, payload) VALUES (1, '{}')`;
        yield* sql`INSERT INTO wechat_inbox (id, generation, payload, done)
        VALUES ('incoming', 'live', '{"text":"run task"}', 0)`;
        yield* sql`INSERT INTO wechat_deliveries
        (id, generation, text, status, created_at, attempts, next_at)
        VALUES ('outgoing', 'live', 'private result', 'pending', 0, 0, 0)`;
        yield* sql`UPDATE wechat_lease SET owner = 'live-server', expires_at = 120000 WHERE id = 1`;
      }
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("keeps stopped and settled thread families and clears pending work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO work_items VALUES ('item', 'project-kept', '2026-08-01', 1, '{}')`;
          yield* sql`INSERT INTO work_item_commands VALUES ('command', '{}', '{}')`;
          yield* sql`INSERT INTO work_item_events (work_item_id, event_type, occurred_at, payload_json)
          VALUES ('item', 'created', '2026-08-01', '{}')`;
          yield* sql`INSERT INTO work_item_outbox (execution_id, work_item_id, effect_type, command_id)
          VALUES ('execution', 'item', 'launch', 'command')`;
          yield* sql`INSERT INTO work_item_discovery VALUES ('project-deleted')`;
          yield* sql`INSERT INTO work_item_candidates VALUES ('stopped-thread', 'project-kept', '{}')`;
          yield* sql`INSERT INTO work_item_ignored VALUES ('stopped-thread', '2026-08-01')`;
          yield* sql`INSERT INTO work_item_delivery_actions VALUES ('item', 1, 'complete', '{}')`;
          yield* sql`INSERT INTO work_item_issue_projects VALUES ('item', 'project-kept')`;
          yield* sql`INSERT INTO workflow_runs
            (run_id, workflow, version, engine_tag, idempotency_key, title, status, started_at, updated_at)
            VALUES ('wf-run-1', 'deploy', 1, 'tag', 'key-1', 'Deploy', 'running', '2026-08-01', '2026-08-01')`;
          yield* sql`INSERT INTO workflow_hooks (hook_id, token) VALUES ('deploy:hook', 'secret-hook-token')`;
          yield* sql`INSERT INTO workflow_triggers (trigger_id, next_at) VALUES ('deploy:daily', '2026-08-02')`;
          yield* Effect.provide(
            Effect.void,
            SqlMessageStorage.layerMigrations({}).pipe(
              Layer.provideMerge(SqlRunnerStorage.layerMigrations({})),
            ),
          );
          yield* sql`INSERT INTO cluster_messages
            (id, shard_id, entity_type, entity_id, kind, tag, payload, headers, request_id)
            VALUES (1, 'default:0', 'Workflow', 'wf-run-1', 0, 'Execute', '{}', '{}', 1)`;
          yield* sql`INSERT INTO cluster_runners (address, runner, healthy) VALUES ('local:1', '{}', 1)`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "statev2.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
          const [pullRequest] = yield* sql<{ url: string | null; watch: string | null }>`
            SELECT
              json_extract(payload_json, '$.pullRequests[0].url') AS url,
              json_extract(payload_json, '$.pullRequests[0].watch') AS watch
            FROM orchestration_v2_projection_threads WHERE thread_id = 'stopped-thread'`;
          const [project] = yield* sql<{ scripts_json: string }>`
            SELECT scripts_json FROM projection_projects WHERE project_id = 'project-kept'`;
          const [leftovers] = yield* sql<{
            auth: number;
            tasks: number;
            webhooks: number;
            transfers: number;
            links: number;
            wechat: number;
            workItems: number;
            workflows: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM scheduled_task_webhook_replay_keys) +
                (SELECT COUNT(*) FROM scheduled_task_webhook_pending) AS webhooks,
              (SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers) AS transfers,
              (SELECT COUNT(*) FROM peer_environment_links) AS links,
              (SELECT COUNT(*) FROM wechat_connection) +
                (SELECT COUNT(*) FROM wechat_inbox) +
                (SELECT COUNT(*) FROM wechat_deliveries) +
                (SELECT COUNT(*) FROM wechat_lease) AS wechat,
              (SELECT COUNT(*) FROM work_items) +
                (SELECT COUNT(*) FROM work_item_commands) +
                (SELECT COUNT(*) FROM work_item_events) +
                (SELECT COUNT(*) FROM work_item_outbox) +
                (SELECT COUNT(*) FROM work_item_discovery) +
                (SELECT COUNT(*) FROM work_item_candidates) +
                (SELECT COUNT(*) FROM work_item_ignored) +
                (SELECT COUNT(*) FROM work_item_delivery_actions) +
                (SELECT COUNT(*) FROM work_item_issue_projects) AS workItems,
              (SELECT COUNT(*) FROM workflow_runs) +
                (SELECT COUNT(*) FROM workflow_hooks) +
                (SELECT COUNT(*) FROM workflow_triggers) +
                (SELECT COUNT(*) FROM cluster_messages) +
                (SELECT COUNT(*) FROM cluster_runners) AS workflows`;
          return { threads, events, sessions, pullRequest, project, leftovers };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.sessions.map((row) => row.provider_session_id),
        ["session-shared"],
      );
      assert.deepStrictEqual(
        kept.pullRequest,
        { url: "https://github.com/owner/repo/pull/7", watch: null },
        "copied pull request links keep their history but stop being watched",
      );
      assert.deepStrictEqual(
        JSON.parse(kept.project?.scripts_json ?? "[]"),
        [
          {
            id: "lint",
            name: "Lint",
            command: "vp lint",
            icon: "lint",
            runOnWorktreeCreate: false,
          },
          {
            id: "teardown",
            name: "Teardown",
            command: "./teardown",
            icon: "configure",
            runOnWorktreeCreate: false,
          },
        ],
        "copied project scripts stay listed but never run on settle in the original checkout",
      );
      assert.deepStrictEqual(kept.leftovers, {
        auth: 0,
        tasks: 0,
        webhooks: 0,
        transfers: 0,
        links: 0,
        wechat: 0,
        workItems: 0,
        workflows: 0,
      });
    }),
  );

  it.effect("drops resumable families from a seed in place, the pending steer included", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-resumable-" });
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-home-" });
      const database = yield* createFixtureSource(dir);

      assert.equal(yield* dropResumableFamilies(database, { sharedHome }), 4);
      const { threads, sessions } = yield* withDatabase(
        database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            threads: yield* sql<{ thread_id: string }>`
              SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`,
            sessions: yield* sql<{ provider_session_id: string }>`
              SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`,
          };
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        [
          "archived-thread",
          "deleted-project-thread",
          "fork-thread",
          "settled-thread",
          "stopped-thread",
        ],
      );
      assert.deepStrictEqual(
        sessions.map((row) => row.provider_session_id),
        ["session-shared"],
        "a session the kept stopped-thread still binds stays with it",
      );
      assert.equal(yield* dropResumableFamilies(database, { sharedHome }), 0);
    }),
  );

  it.effect("refuses to drop from the shared database through a symlink or a hard link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-link-" });
      const fixture = yield* createFixtureSource(sharedHome);
      const live = path.join(sharedHome, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(live), { recursive: true });
      yield* fs.rename(fixture, live);
      const symlink = path.join(elsewhere, "statev2.sqlite");
      yield* fs.symlink(live, symlink);
      // A hard link has its own path; only the file's identity gives it away.
      const hardLink = path.join(elsewhere, "copy.sqlite");
      yield* fs.link(live, hardLink);

      for (const link of [symlink, hardLink]) {
        const refused = yield* Effect.flip(dropResumableFamilies(link, { sharedHome }));
        assert.equal(refused._tag, "MigrateDevDbSharedHomeError", link);
      }
      const threads = yield* withDatabase(
        live,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{ n: number }>`
            SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads`;
          return Number(row?.n ?? 0);
        }),
      );
      assert.equal(threads, 10, "the shared database is untouched");
    }),
  );

  it.effect(
    "refuses to drop from a custom T3CODE_HOME, installed home, symlinked live db, or hard link",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
        const customHome = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-custom-" });
        const installedHome = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-installed-",
        });
        const externalDisk = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-disk-" });
        const stagingDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-stage-" });

        const customFixture = yield* createFixtureSource(customHome);
        const customDb = path.join(customHome, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(customDb), { recursive: true });
        yield* fs.rename(customFixture, customDb);

        const installedFixture = yield* createFixtureSource(installedHome);
        const realDiskDb = path.join(externalDisk, "statev2.sqlite");
        yield* fs.rename(installedFixture, realDiskDb);
        const installedDb = path.join(installedHome, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.join(installedHome, "runtime"), { recursive: true });
        yield* fs.writeFileString(path.join(installedHome, "runtime", "service-state.json"), "{}");
        yield* fs.makeDirectory(path.dirname(installedDb), { recursive: true });
        yield* fs.symlink(realDiskDb, installedDb);

        const refusedAmbient = yield* Effect.flip(
          dropResumableFamilies(customDb, { sharedHome, ambientHome: customHome }),
        );
        assert.equal(refusedAmbient._tag, "MigrateDevDbSharedHomeError");

        const refusedSymlinkedInstalled = yield* Effect.flip(
          dropResumableFamilies(installedDb, { sharedHome }),
        );
        assert.equal(refusedSymlinkedInstalled._tag, "MigrateDevDbSharedHomeError");

        // Two-hop symlink: alias/state-link -> installedHome/userdata, and statev2.sqlite -> realDiskDb.
        const aliasDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-alias-" });
        yield* fs.symlink(path.join(installedHome, "userdata"), path.join(aliasDir, "state-link"));
        const twoHopDb = path.join(aliasDir, "state-link", "statev2.sqlite");
        const refusedTwoHop = yield* Effect.flip(dropResumableFamilies(twoHopDb, { sharedHome }));
        assert.equal(refusedTwoHop._tag, "MigrateDevDbSharedHomeError");

        // Two-hop file symlink: stagingDir/alias.sqlite -> installedHome/userdata/statev2.sqlite -> realDiskDb.
        const twoHopFileDb = path.join(stagingDir, "alias.sqlite");
        yield* fs.symlink(installedDb, twoHopFileDb);
        const refusedTwoHopFile = yield* Effect.flip(
          dropResumableFamilies(twoHopFileDb, { sharedHome }),
        );
        assert.equal(refusedTwoHopFile._tag, "MigrateDevDbSharedHomeError");
        const preservedThreads = yield* withDatabase(
          realDiskDb,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [row] = yield* sql<{ n: number }>`
              SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads`;
            return Number(row?.n ?? 0);
          }),
        );
        assert.equal(preservedThreads, 10);

        // POSIX resolves directory symlinks before `..`, whereas Windows normalizes `..` lexically first.
        const platform = yield* HostProcess.Platform;
        if (platform !== "win32") {
          const nestedParentDir = yield* fs.makeTempDirectoryScoped({
            prefix: "migrate-dev-db-dotdot-",
          });
          const nestedTargetDir = path.join(nestedParentDir, "sub");
          yield* fs.makeDirectory(nestedTargetDir, { recursive: true });
          const decoyCopy = yield* createFixtureSource(stagingDir);
          const decoyDb = path.join(stagingDir, "decoy.sqlite");
          yield* fs.rename(decoyCopy, decoyDb);
          yield* fs.symlink(nestedTargetDir, path.join(stagingDir, "dir-link"));
          const dotDotPath = `${path.join(stagingDir, "dir-link")}${path.sep}..${path.sep}decoy.sqlite`;
          const refusedDotDot = yield* Effect.flip(
            dropResumableFamilies(dotDotPath, { sharedHome }),
          );
          assert.equal(refusedDotDot._tag, "MigrateDevDbSourceMissingError");
          const decoyThreads = yield* withDatabase(
            decoyDb,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const [row] = yield* sql<{ n: number }>`
                SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads`;
              return Number(row?.n ?? 0);
            }),
          );
          assert.equal(decoyThreads, 10);

          const liveInParent = yield* createFixtureSource(nestedParentDir);
          yield* fs.makeDirectory(path.join(nestedParentDir, "runtime"), { recursive: true });
          yield* fs.writeFileString(
            path.join(nestedParentDir, "runtime", "service-state.json"),
            "{}",
          );
          const dotDotLivePath = `${path.join(stagingDir, "dir-link")}${path.sep}..${path.sep}userdata${path.sep}statev2.sqlite`;
          const refusedDotDotLive = yield* Effect.flip(
            dropResumableFamilies(dotDotLivePath, { sharedHome }),
          );
          assert.equal(refusedDotDotLive._tag, "MigrateDevDbSharedHomeError");
          assert.equal(
            yield* withDatabase(
              liveInParent,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const [row] = yield* sql<{ n: number }>`
                  SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads`;
                return Number(row?.n ?? 0);
              }),
            ),
            10,
          );
        }

        const missingDb = path.join(stagingDir, "typo.sqlite");
        const refusedMissing = yield* Effect.flip(dropResumableFamilies(missingDb, { sharedHome }));
        assert.equal(refusedMissing._tag, "MigrateDevDbSourceMissingError");
        assert.isFalse(yield* fs.exists(missingDb));

        const hardLinkedDb = path.join(stagingDir, "hardlinked.sqlite");
        yield* fs.link(customDb, hardLinkedDb);
        const refusedHardLink = yield* Effect.flip(
          dropResumableFamilies(hardLinkedDb, { sharedHome }),
        );
        assert.equal(refusedHardLink._tag, "MigrateDevDbSharedHomeError");
      }),
  );

  it.effect("never copies an archived thread, and new events append after the source's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const [sourceSequence] = yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
        { sharedHome: sourceDir },
      );

      const copied = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [archivedRows] = yield* sql<{ count: number }>`
            SELECT
              (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = 'archived-thread')
              + (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = 'archived-thread')
              AS count`;
          const [sequence] = yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
          return { archivedRows: archivedRows?.count, sequence: sequence?.seq };
        }),
      );
      assert.equal(copied.archivedRows, 0);
      assert.equal(copied.sequence, sourceSequence?.seq);
    }),
  );

  it.effect("skips a thread family larger than the per-project limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      // stopped-thread and its fork are 2 threads; settled-thread is 1.
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["settled-thread"],
      );
    }),
  );

  it.effect("upgrades a source from before the V2 thread tables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-dest-" });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(source, runMigrations({ toMigrationInclusive: 54 }));

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      assert.include(result.executedMigrations, "55_OrchestrationV2");
    }),
  );

  // The server imports V1 threads at boot, not in a migration, so a source can
  // reach the V2 schema with its legacy threads still unimported.
  it.effect.each([
    { name: "a pre-V2 source", migrateToLatest: false },
    { name: "a V2 source whose legacy threads were never imported", migrateToLatest: true },
  ])("refuses $name", ({ migrateToLatest }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-data-" });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-v1-data-dest-",
      });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 54 });
          yield* sql`INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
            VALUES ('project-legacy', 'Legacy', '/tmp/legacy', '[]', '2026-08-01', '2026-08-01')`;
          yield* sql`INSERT INTO projection_threads
            (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
            VALUES ('thread-legacy', 'project-legacy', 'Legacy thread',
              '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-08-01', '2026-08-01')`;
          if (migrateToLatest) yield* runMigrations();
        }),
      );

      // A live destination connection keeps uncheckpointed rows in the WAL;
      // the rejected run must leave those bytes alone.
      const destination = yield* createFixtureSource(destDir);
      yield* withDatabase(
        destination,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
          yield* sql`UPDATE projection_projects SET title = 'Edited' WHERE project_id = 'project-kept'`;
          const walBefore = yield* fs.readFile(`${destination}-wal`);
          assert.isAbove(walBefore.length, 0);

          const error = yield* runMigrateDevDb(
            { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
            { sharedHome: sourceDir },
          ).pipe(Effect.flip);
          assert.equal(error._tag, "MigrateDevDbLegacySourceError");
          assert.deepStrictEqual(yield* fs.readFile(`${destination}-wal`), walBefore);
        }),
      );
    }),
  );

  it.effect("seeds from a source that recorded another migration below V2", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-local-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-local-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations SET name = 'SiteLocalMigration'
            WHERE migration_id = 51`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
    }),
  );

  it.effect("refuses a source whose V2 migration history clashes with this checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-clash-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-clash-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations SET name = 'OtherBuildMigration'
            WHERE migration_id = 60`;
        }),
      );

      const destination = yield* createFixtureSource(destDir);
      const sourceBefore = yield* fs.readFile(source);
      const destinationBefore = yield* fs.readFile(destination);

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbPhaseError");
      if (error._tag === "MigrateDevDbPhaseError") {
        assert.equal(error.phase, "migrate");
        assert.include(String(error.cause), "60_ThreadSnapshotWindowIndexes");
      }
      assert.deepStrictEqual(yield* fs.readFile(source), sourceBefore);
      assert.deepStrictEqual(yield* fs.readFile(destination), destinationBefore);
    }),
  );

  it.effect("imports a dev seed whose ids after 67 came from the peer links branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-peer-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-peer-dest-" });
      const source = yield* createFixtureSource(sourceDir, 67);
      // Mirrors a real ~/.t3 seed written by a build whose 68-70 differ from main's.
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE peer_environment_links (
            environment_id TEXT PRIMARY KEY,
            secret_name TEXT NOT NULL,
            label TEXT NOT NULL,
            urls_json TEXT NOT NULL,
            access TEXT NOT NULL,
            linked_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_reached_at TEXT,
            last_error TEXT,
            fenced INTEGER NOT NULL DEFAULT 0)`;
          yield* sql`CREATE INDEX orchestration_v2_projection_turn_items_waiting_link_idx
            ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC, turn_item_id DESC)
            WHERE type = 'link_request' AND status = 'waiting'`;
          yield* insertPeerLink(sql);
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (68, 'PeerLinks'), (69, 'PeerLinkFence'), (70, 'WaitingLinkRequestIndex')`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      const imported = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const schema = yield* sql<{ name: string }>`
            SELECT name FROM sqlite_master WHERE name IN (
              'orchestration_v2_projection_turn_items_stop_request_idx',
              'orchestration_v2_message_search')
            ORDER BY name`;
          return { threads, schema };
        }),
      );
      assert.deepStrictEqual(
        imported.threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        imported.schema.map((row) => row.name),
        [
          "orchestration_v2_message_search",
          "orchestration_v2_projection_turn_items_stop_request_idx",
        ],
      );
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect("refuses a source that resolves to a destination path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      yield* fs.makeDirectory(path.join(destDir, "userdata"), { recursive: true });
      for (const fileName of [
        "statev2.sqlite",
        "statev2.sqlite-wal",
        "statev2.sqlite-shm",
        "statev2.sqlite.migrate-dev-db-tmp",
        "statev2.sqlite.migrate-dev-db-tmp-wal",
        "statev2.sqlite.migrate-dev-db-tmp-shm",
      ]) {
        const candidate = path.join(destDir, "userdata", fileName);
        yield* fs.writeFileString(candidate, `backup-bytes-${fileName}`);
        const error = yield* runMigrateDevDb(
          { baseDir: destDir, source: candidate, projects: 5, threadsPerProject: 10 },
          { sharedHome: sharedDir },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError", fileName);
        assert.equal(yield* fs.readFileString(candidate), `backup-bytes-${fileName}`);
      }
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );

  it.effect("protects the configured home in both migration modes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const live = path.join(home, "cli");
      const source = yield* createFixtureSource(live);
      const options = { sharedHome: path.join(home, ".t3"), ambientHome: " ~/cli " };
      const migrate = runMigrateDevDb(
        { baseDir: live, source, projects: 1, threadsPerProject: 1 },
        options,
      );
      const [migration, drop] = yield* Effect.all([
        Effect.flip(migrate),
        Effect.flip(dropResumableFamilies(source, options)),
      ]).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      assert.equal(migration._tag, "MigrateDevDbSharedHomeError");
      assert.equal(drop._tag, "MigrateDevDbSharedHomeError");
      const unresolved = path.join(home, "unresolved");
      yield* fs.symlink(path.join(home, "absent"), unresolved);
      const error = yield* dropResumableFamilies(source, {
        ...options,
        ambientHome: unresolved,
      }).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );

  it.effect("stops if an existing snapshot cannot be removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped();
      const source = yield* createFixtureSource(sharedHome);
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const stateDir = path.join(baseDir, "userdata");
      const database = path.join(stateDir, "statev2.sqlite");
      const snapshot = `${database}.migrate-dev-db-tmp`;
      yield* fs.makeDirectory(stateDir);
      yield* fs.writeFileString(snapshot, "previous snapshot");
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: snapshot,
      });
      const error = yield* runMigrateDevDb(
        { baseDir, source, projects: 1, threadsPerProject: 1 },
        { sharedHome },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          remove: (file, options) =>
            path.basename(file) === path.basename(snapshot)
              ? Effect.fail(denied)
              : fs.remove(file, options),
        }),
        Effect.flip,
      );
      assert.equal(error, denied);
      assert.equal(yield* fs.readFileString(snapshot), "previous snapshot");
      assert.isFalse(yield* fs.exists(database));
    }),
  );

  it.effect("retains an independent source hard-linked to the snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped();
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const stateDir = path.join(baseDir, "userdata");
      const source = path.join(baseDir, "backup.sqlite");
      const snapshot = path.join(stateDir, "statev2.sqlite.migrate-dev-db-tmp");
      yield* fs.makeDirectory(stateDir);
      yield* fs.writeFileString(source, "backup");
      yield* fs.link(source, snapshot);
      let reads = 0;
      const error = yield* runMigrateDevDb(
        { baseDir, source, projects: 1, threadsPerProject: 1 },
        { sharedHome },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (file) =>
            path.basename(file) === "backup.sqlite" && ++reads > 1
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "stat",
                    pathOrDescriptor: file,
                  }),
                )
              : fs.stat(file),
        }),
        Effect.flip,
      );
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.readFileString(source), "backup");
      assert.equal(yield* fs.readFileString(snapshot), "backup");
    }),
  );

  it.effect(
    "refuses to overwrite a stopped installed home while still refreshing an ordinary dev worktree",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src2-" });
        const installedDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-installed-dest-",
        });
        const devWorktreeDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-worktree-dest-",
        });

        const source = yield* createFixtureSource(sourceDir);
        const installedDb = path.join(installedDir, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(installedDb), { recursive: true });
        yield* fs.writeFileString(installedDb, "live-installed-database-bytes");
        yield* fs.makeDirectory(path.join(installedDir, "runtime"), { recursive: true });
        yield* fs.writeFileString(path.join(installedDir, "runtime", "service-state.json"), "{}");

        const refused = yield* runMigrateDevDb(
          { baseDir: installedDir, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: sourceDir },
        ).pipe(Effect.flip);
        assert.equal(refused._tag, "MigrateDevDbSharedHomeError");
        assert.equal(yield* fs.readFileString(installedDb), "live-installed-database-bytes");

        // A stopped packaged desktop home outside a worktree is also refused.
        const desktopInstallDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-desktop-install-",
        });
        const desktopInstallDb = path.join(desktopInstallDir, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(desktopInstallDb), { recursive: true });
        yield* fs.writeFileString(desktopInstallDb, "packaged-desktop-database-bytes");
        yield* fs.writeFileString(
          path.join(desktopInstallDir, "userdata", "desktop-last-started-version"),
          "1.0.0",
        );
        const refusedDesktopInstall = yield* runMigrateDevDb(
          { baseDir: desktopInstallDir, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: sourceDir },
        ).pipe(Effect.flip);
        assert.equal(refusedDesktopInstall._tag, "MigrateDevDbSharedHomeError");
        assert.equal(yield* fs.readFileString(desktopInstallDb), "packaged-desktop-database-bytes");

        // A linked git worktree that previously ran `vp run dev:desktop` still refreshes cleanly.
        yield* fs.writeFileString(
          path.join(devWorktreeDir, ".git"),
          "gitdir: /repo/.git/worktrees/feature-branch\n",
        );
        const devWorktreeHome = path.join(devWorktreeDir, ".t3");
        yield* fs.makeDirectory(path.join(devWorktreeHome, "userdata", "secrets"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(devWorktreeHome, "userdata", "settings.json"), "{}");
        yield* fs.writeFileString(
          path.join(devWorktreeHome, "userdata", "desktop-last-started-version"),
          "0.0.0-dev",
        );
        yield* fs.writeFileString(
          path.join(devWorktreeHome, "userdata", "desktop-settings.json"),
          "{}",
        );
        const refreshed = yield* runMigrateDevDb(
          { baseDir: devWorktreeHome, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: sourceDir },
        );
        assert.equal(
          refreshed.databasePath,
          path.join(devWorktreeHome, "userdata", "statev2.sqlite"),
        );

        const platform = yield* HostProcess.Platform;
        if (platform !== "win32") {
          // On POSIX, `dirA/link/..` resolves to `dirB` (because `dirA/link -> dirB/sub`), never `dirA`.
          const dirA = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-base-a-" });
          const dirB = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-base-b-" });
          yield* fs.makeDirectory(path.join(dirB, "sub"), { recursive: true });
          yield* fs.symlink(path.join(dirB, "sub"), path.join(dirA, "link"));
          const dbInA = path.join(dirA, "userdata", "statev2.sqlite");
          yield* fs.makeDirectory(path.dirname(dbInA), { recursive: true });
          yield* fs.writeFileString(dbInA, "unintended-dev-db-in-a");

          const dotDotBaseDir = `${path.join(dirA, "link")}${path.sep}..`;
          const migratedDotDot = yield* runMigrateDevDb(
            { baseDir: dotDotBaseDir, source, projects: 5, threadsPerProject: 2 },
            { sharedHome: sourceDir },
          );
          assert.equal(
            migratedDotDot.databasePath,
            path.join(yield* fs.realPath(dirB), "userdata", "statev2.sqlite"),
          );
          assert.equal(yield* fs.readFileString(dbInA), "unintended-dev-db-in-a");

          // Explicit `--source` with `link/..`: lexical `srcA/seed.sqlite` exists, but real `srcB/seed.sqlite` is missing.
          const srcA = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-a-" });
          const srcB = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-b-" });
          yield* fs.makeDirectory(path.join(srcB, "sub"), { recursive: true });
          yield* fs.symlink(path.join(srcB, "sub"), path.join(srcA, "link"));
          const lexicalSource = yield* createFixtureSource(srcA);
          const keepTargetDir = yield* fs.makeTempDirectoryScoped({
            prefix: "migrate-dev-db-src-dotdot-dest-",
          });
          const existingDestDb = path.join(keepTargetDir, "userdata", "statev2.sqlite");
          yield* fs.makeDirectory(path.dirname(existingDestDb), { recursive: true });
          yield* fs.writeFileString(existingDestDb, "preserve-existing-dest");
          assert.isTrue(yield* fs.exists(lexicalSource));
          const dotDotSource = `${path.join(srcA, "link")}${path.sep}..${path.sep}userdata${path.sep}statev2.sqlite`;
          const refusedDotDotSource = yield* runMigrateDevDb(
            { baseDir: keepTargetDir, source: dotDotSource, projects: 5, threadsPerProject: 2 },
            { sharedHome: sourceDir },
          ).pipe(Effect.flip);
          assert.equal(refusedDotDotSource._tag, "MigrateDevDbSourceMissingError");
          assert.equal(yield* fs.readFileString(existingDestDb), "preserve-existing-dest");

          // POSIX preserves literal backslashes in missing directory names instead of splitting on `\`.
          const slashRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "migrate-dev-db-backslash-",
          });
          const nestedSlashDir = path.join(slashRoot, "2.72", "bin");
          const nestedSlashDb = path.join(nestedSlashDir, "userdata", "statev2.sqlite");
          yield* fs.makeDirectory(path.dirname(nestedSlashDb), { recursive: true });
          yield* fs.writeFileString(nestedSlashDb, "existing-slash-nested-db");
          const backslashBaseDir = path.join(slashRoot, "2.72\\bin");
          const migratedBackslash = yield* runMigrateDevDb(
            { baseDir: backslashBaseDir, source, projects: 5, threadsPerProject: 2 },
            { sharedHome: sourceDir },
          );
          assert.equal(
            migratedBackslash.databasePath,
            path.join(backslashBaseDir, "userdata", "statev2.sqlite"),
          );
          assert.equal(yield* fs.readFileString(nestedSlashDb), "existing-slash-nested-db");

          // Trailing `/.` on a not-yet-created `--base-dir` resolves cleanly instead of failing closed.
          const trailingDotDir = path.join(slashRoot, "new-home");
          const migratedTrailingDot = yield* runMigrateDevDb(
            { baseDir: `${trailingDotDir}/.`, source, projects: 5, threadsPerProject: 2 },
            { sharedHome: sourceDir },
          );
          assert.isTrue(yield* fs.exists(migratedTrailingDot.databasePath));
        }

        // Default `--base-dir` omitted: a worktree `.t3` symlinked to `T3CODE_HOME` whose `userdata`
        // is in turn symlinked to an external `state` directory must still be refused.
        const linkedWorktreeRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-default-wt-",
        });
        const cliAmbientHome = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-cli-home-",
        });
        const externalStateDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-ext-state-",
        });
        const externalLiveDb = path.join(externalStateDir, "statev2.sqlite");
        yield* fs.writeFileString(externalLiveDb, "cli-ambient-live-db-bytes");
        yield* fs.symlink(externalStateDir, path.join(cliAmbientHome, "userdata"));
        yield* fs.writeFileString(
          path.join(linkedWorktreeRoot, ".git"),
          "gitdir: /repo/.git/worktrees/default-branch\n",
        );
        yield* fs.symlink(cliAmbientHome, path.join(linkedWorktreeRoot, ".t3"));
        const refusedDefaultTwoHop = yield* runMigrateDevDb(
          { projects: 5, threadsPerProject: 2, source },
          { sharedHome: sourceDir, ambientHome: cliAmbientHome, cwd: linkedWorktreeRoot },
        ).pipe(Effect.flip);
        assert.equal(refusedDefaultTwoHop._tag, "MigrateDevDbSharedHomeError");
        assert.equal(yield* fs.readFileString(externalLiveDb), "cli-ambient-live-db-bytes");

        // Distinct homes sharing the same external `state` directory via `userdata` symlinks must also be refused.
        const separateWorktreeRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-separate-wt-",
        });
        yield* fs.writeFileString(
          path.join(separateWorktreeRoot, ".git"),
          "gitdir: /repo/.git/worktrees/separate-branch\n",
        );
        const separateWorktreeHome = path.join(separateWorktreeRoot, ".t3");
        yield* fs.makeDirectory(separateWorktreeHome, { recursive: true });
        yield* fs.symlink(externalStateDir, path.join(separateWorktreeHome, "userdata"));
        const refusedSharedStateDir = yield* runMigrateDevDb(
          { projects: 5, threadsPerProject: 2, source },
          { sharedHome: sourceDir, ambientHome: cliAmbientHome, cwd: separateWorktreeRoot },
        ).pipe(Effect.flip);
        assert.equal(refusedSharedStateDir._tag, "MigrateDevDbSharedHomeError");
        assert.equal(yield* fs.readFileString(externalLiveDb), "cli-ambient-live-db-bytes");

        // Hard link (same dev:ino, distinct canonical path) to a protected live database must be refused.
        const hardLinkDestHome = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-hardlink-dest-",
        });
        const hardLinkedDestDb = path.join(hardLinkDestHome, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(hardLinkedDestDb), { recursive: true });
        yield* fs.link(externalLiveDb, hardLinkedDestDb);
        const refusedHardLinkedDest = yield* runMigrateDevDb(
          { baseDir: hardLinkDestHome, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: sourceDir, ambientHome: cliAmbientHome },
        ).pipe(Effect.flip);
        assert.equal(refusedHardLinkedDest._tag, "MigrateDevDbSharedHomeError");
        assert.equal(yield* fs.readFileString(externalLiveDb), "cli-ambient-live-db-bytes");

        // An unreadable or dangling protected `T3CODE_HOME` must fail closed instead of falling back lexically.
        const danglingAmbientParent = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-unverified-ambient-",
        });
        const danglingAmbientLink = path.join(danglingAmbientParent, "ambient-link");
        yield* fs.symlink(path.join(danglingAmbientParent, "missing-ambient"), danglingAmbientLink);
        const unverifiedDestHome = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-unverified-dest-",
        });
        const refusedUnverifiedProtected = yield* runMigrateDevDb(
          { baseDir: unverifiedDestHome, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: sourceDir, ambientHome: danglingAmbientLink },
        ).pipe(Effect.flip);
        assert.equal(refusedUnverifiedProtected._tag, "MigrateDevDbSharedHomeError");

        // Symlink to an existing standalone file at destination or snapshot filename must be refused without unlinking.
        const standaloneTargetDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-standalone-file-",
        });
        const standaloneFile = path.join(standaloneTargetDir, "existing-file.sqlite");
        yield* fs.writeFileString(standaloneFile, "standalone-existing-file-bytes");
        for (const fileName of ["statev2.sqlite", "statev2.sqlite.migrate-dev-db-tmp"]) {
          const symlinkedFileHome = yield* fs.makeTempDirectoryScoped({
            prefix: "migrate-dev-db-file-symlink-dest-",
          });
          const linkAtDest = path.join(symlinkedFileHome, "userdata", fileName);
          yield* fs.makeDirectory(path.dirname(linkAtDest), { recursive: true });
          yield* fs.symlink(standaloneFile, linkAtDest);
          const refusedFileSymlink = yield* runMigrateDevDb(
            { baseDir: symlinkedFileHome, source, projects: 5, threadsPerProject: 2 },
            { sharedHome: sourceDir },
          ).pipe(Effect.flip);
          assert.equal(refusedFileSymlink._tag, "MigrateDevDbSharedHomeError", fileName);
          assert.equal((yield* fs.lstat(linkAtDest)).type, "SymbolicLink");
          assert.equal(yield* fs.readFileString(standaloneFile), "standalone-existing-file-bytes");
        }

        // Dangling symlink at destination `statev2.sqlite` or `--base-dir link/.` must fail closed without unlinking.
        const danglingDestHome = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-dangling-dest-",
        });
        const danglingDbLink = path.join(danglingDestHome, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(danglingDbLink), { recursive: true });
        yield* fs.symlink(path.join(danglingDestHome, "missing-target.sqlite"), danglingDbLink);
        const refusedDanglingDb = yield* runMigrateDevDb(
          { baseDir: danglingDestHome, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: sourceDir },
        ).pipe(Effect.flip);
        assert.equal(refusedDanglingDb._tag, "MigrateDevDbSharedHomeError");
        assert.equal((yield* fs.lstat(danglingDbLink)).type, "SymbolicLink");

        const danglingBaseLink = path.join(danglingDestHome, "dangling-home-link");
        yield* fs.symlink(path.join(danglingDestHome, "nowhere"), danglingBaseLink);
        const refusedDanglingBaseDot = yield* runMigrateDevDb(
          { baseDir: `${danglingBaseLink}/.`, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: sourceDir },
        ).pipe(Effect.flip);
        assert.equal(refusedDanglingBaseDot._tag, "MigrateDevDbSharedHomeError");
        assert.equal((yield* fs.lstat(danglingBaseLink)).type, "SymbolicLink");

        // Platform path-splitting rules: Windows drive-relative paths (`C:seed`), roots, `.` termination, and POSIX backslashes.
        assert.equal(splitPathParentAndLeaf(".", "darwin"), undefined);
        assert.equal(splitPathParentAndLeaf(".", "win32"), undefined);
        assert.deepStrictEqual(splitPathParentAndLeaf("./.", "darwin"), {
          parent: ".",
          leaf: ".",
        });
        assert.deepStrictEqual(splitPathParentAndLeaf("C:seed", "win32"), {
          parent: "C:",
          leaf: "seed",
        });
        assert.deepStrictEqual(splitPathParentAndLeaf("C:dir\\seed\\.", "win32"), {
          parent: "C:dir\\seed",
          leaf: ".",
        });
        assert.equal(splitPathParentAndLeaf("C:\\", "win32"), undefined);
        assert.equal(splitPathParentAndLeaf("C:", "win32"), undefined);
        assert.deepStrictEqual(splitPathParentAndLeaf("/tmp/2.72\\bin/.", "darwin"), {
          parent: "/tmp/2.72\\bin",
          leaf: ".",
        });
        assert.deepStrictEqual(splitPathParentAndLeaf("/tmp/2.72\\bin", "darwin"), {
          parent: "/tmp",
          leaf: "2.72\\bin",
        });
      }),
  );
});
