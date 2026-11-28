import * as Schema from "effect/Schema";
import { RunId, ThreadId } from "./baseSchemas.ts";

export const ThreadPredictionInput = Schema.Struct({
  threadId: ThreadId,
  sourceRunId: RunId,
  suggestionFallback: Schema.optionalKey(Schema.Struct({ legacyModelEnabled: Schema.Boolean })),
});
export type ThreadPredictionInput = typeof ThreadPredictionInput.Type;

export const MAX_THREAD_PREDICTION_LENGTH = 500;

export const ThreadPredictionResult = Schema.Struct({
  sourceRunId: RunId,
  text: Schema.NullOr(Schema.String.check(Schema.isMaxLength(MAX_THREAD_PREDICTION_LENGTH))),
});
export type ThreadPredictionResult = typeof ThreadPredictionResult.Type;

export class ThreadPredictionError extends Schema.TaggedError<
  ThreadPredictionError,
  { readonly brand: unique symbol }
>()("ThreadPredictionError", { threadId: ThreadId, cause: Schema.Defect() }) {
  override get message(): string {
    return "Could not predict the next message.";
  }
}
