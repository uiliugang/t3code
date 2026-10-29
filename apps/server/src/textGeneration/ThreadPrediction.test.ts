import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as ThreadPrediction from "./ThreadPrediction.ts";

const threadId = ThreadId.make("prediction-thread");
const sourceRunId = RunId.make("prediction-run");
const projectId = ProjectId.make("prediction-project");
const input = { threadId, sourceRunId };
const makeShell = () =>
  ({
    id: threadId,
    projectId,
    status: "completed",
    latestRunId: sourceRunId,
    activeRunId: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    pendingBackgroundTasks: [],
    hasActionableProposedPlan: false,
    archivedAt: null,
    deletedAt: null,
    worktreePath: "/home/user/app-worktree",
  }) as unknown as OrchestrationV2ThreadShell;

function layer(
  readShell: () => OrchestrationV2ThreadShell,
  generate: TextGeneration.TextGeneration["Service"]["generatePredictedMessage"],
) {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: MessageId.make(`message-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${index}:` + "x".repeat(4_000),
    streaming: false,
    runId: sourceRunId,
  }));
  return ThreadPrediction.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadShell: () => Effect.sync(readShell),
        getThreadSnapshotWindow: (
          _threadId: ThreadId,
          options: { readonly rowLimit: number; readonly userTurnLimit?: number },
        ) => {
          assert.deepEqual(options, { rowLimit: 32, userTurnLimit: 4 });
          return Effect.succeed({
            projection: { messages } as unknown as OrchestrationV2ThreadProjection,
          });
        },
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProjectStore.ProjectStoreV2, {
        get: () => Effect.succeedSome({ workspaceRoot: "/home/user/app" }),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    ),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(
      Layer.succeed(TextGeneration.TextGeneration, {
        generatePredictedMessage: generate,
      } as unknown as TextGeneration.TextGeneration["Service"]),
    ),
  );
}

it.effect("predicts from thread detail with a body-free shell and reuses concurrent requests", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let calls = 0;
    const testLayer = layer(makeShell, (request) =>
      Effect.gen(function* () {
        calls++;
        assert.equal(request.cwd, "/home/user/app-worktree");
        assert.equal(request.messages.length, 8);
        assert(request.messages.every((message) => message.text.length <= 3_000));
        assert.deepEqual(
          request.modelSelection,
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        );
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(finish);
        return { text: "Show the focused test results" };
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadPrediction.ThreadPrediction;
      const first = yield* service.predict(input).pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(first));
      assert.equal(yield* Deferred.isDone(started), true);
      const second = yield* service.predict({ ...input }).pipe(Effect.forkChild);
      yield* Deferred.succeed(finish, undefined);
      assert.deepEqual(yield* Fiber.join(first), {
        sourceRunId,
        text: "Show the focused test results",
      });
      assert.deepEqual(yield* Fiber.join(second), {
        sourceRunId,
        text: "Show the focused test results",
      });
      assert.equal(calls, 1);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("does not generate for an old, active, interrupted, or blocked run", () =>
  Effect.gen(function* () {
    let shell = makeShell();
    let calls = 0;
    const testLayer = layer(
      () => shell,
      () =>
        Effect.sync(() => {
          calls++;
          return { text: "wrong" };
        }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadPrediction.ThreadPrediction;
      for (const patch of [
        { latestRunId: RunId.make("new-run") },
        { activeRunId: sourceRunId },
        { status: "interrupted" as const },
        { status: "running" as const },
        { hasActionableProposedPlan: true },
      ]) {
        shell = { ...makeShell(), ...patch };
        assert.deepEqual(yield* service.predict(input), { sourceRunId, text: null });
      }
      assert.equal(calls, 0);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("drops generated text when a newer run starts while the model is working", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let shell = makeShell();
    yield* Effect.gen(function* () {
      const service = yield* ThreadPrediction.ThreadPrediction;
      const pending = yield* service.predict(input).pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(pending));
      assert.equal(yield* Deferred.isDone(started), true);
      shell = { ...shell, latestRunId: RunId.make("new-run"), activeRunId: RunId.make("new-run") };
      yield* Deferred.succeed(finish, undefined);
      assert.deepEqual(yield* Fiber.join(pending), { sourceRunId, text: null });
    }).pipe(
      Effect.provide(
        layer(
          () => shell,
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
              return { text: "stale" };
            }),
        ),
      ),
    );
  }),
);
