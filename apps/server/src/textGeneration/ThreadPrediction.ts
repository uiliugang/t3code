import {
  ModelSelection,
  ThreadPredictionError,
  type ThreadPredictionInput,
  type ThreadPredictionResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { threadPredictionSourceRun } from "@t3tools/shared/threadPrediction";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "./TextGeneration.ts";

export class ThreadPrediction extends Context.Service<
  ThreadPrediction,
  {
    readonly predict: (
      input: ThreadPredictionInput,
    ) => Effect.Effect<ThreadPredictionResult, ThreadPredictionError>;
  }
>()("t3/textGeneration/ThreadPrediction") {}

class PredictionCacheKey extends Data.Class<ThreadPredictionInput & { readonly model: string }> {}

const encodeModel = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const decodeModel = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const generation = yield* TextGeneration.TextGeneration;
  const cache = yield* Cache.make({
    capacity: 128,
    timeToLive: "10 minutes",
    lookup: Effect.fn("ThreadPrediction.generate")(function* (
      input: ThreadPredictionInput & { readonly model: string },
    ) {
      const shell = yield* projections.getThreadShell(input.threadId);
      if (threadPredictionSourceRun(shell) !== input.sourceRunId || !shell) return null;
      const project = yield* projects.get(shell.projectId);
      if (Option.isNone(project)) return null;
      const snapshot = yield* projections.getThreadSnapshotWindow(input.threadId, {
        rowLimit: 32,
        userTurnLimit: 4,
      });
      const messages = snapshot.projection.messages
        .filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            !message.streaming &&
            !message.notification &&
            !message.idleCompaction &&
            !message.workflowScript &&
            !message.senderThreadId &&
            message.text.trim().length > 0,
        )
        .slice(-8);
      const latestMessage = messages.at(-1);
      if (
        latestMessage?.role !== "assistant" ||
        latestMessage.runId !== input.sourceRunId ||
        !messages.some((message) => message.role === "user")
      )
        return null;
      const result = yield* generation
        .generatePredictedMessage({
          cwd: shell.worktreePath ?? project.value.workspaceRoot,
          messages: messages.map((message) => ({
            role: message.role as "user" | "assistant",
            text: message.text.slice(-3_000),
          })),
          modelSelection: yield* decodeModel(input.model),
        })
        .pipe(Effect.timeoutOption("20 seconds"));
      return Option.isSome(result) ? result.value.text : null;
    }),
  });

  const predict = Effect.fn("ThreadPrediction.predict")(
    function* (input: ThreadPredictionInput) {
      const empty = { sourceRunId: input.sourceRunId, text: null };
      const shell = yield* projections.getThreadShell(input.threadId);
      if (threadPredictionSourceRun(shell) !== input.sourceRunId || !shell) return empty;
      const modelSelection = resolveProjectSettings(yield* settings.getSettings, shell.projectId)
        .settings.textGenerationModelSelection;
      const text = yield* Cache.get(
        cache,
        new PredictionCacheKey({ ...input, model: yield* encodeModel(modelSelection) }),
      );
      const current = yield* projections.getThreadShell(input.threadId);
      return {
        sourceRunId: input.sourceRunId,
        text: threadPredictionSourceRun(current) === input.sourceRunId ? text : null,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) => new ThreadPredictionError({ threadId: input.threadId, cause })),
      ),
  );

  return ThreadPrediction.of({ predict });
});

export const layer = Layer.effect(ThreadPrediction, make);
