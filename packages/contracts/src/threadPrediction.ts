import * as Schema from "effect/Schema";
import { RunId, ThreadId } from "./baseSchemas.ts";

export const ThreadPredictionInput = Schema.Struct({
  threadId: ThreadId,
  sourceRunId: RunId,
});
export type ThreadPredictionInput = typeof ThreadPredictionInput.Type;

export const ThreadPredictionResult = Schema.Struct({
  sourceRunId: RunId,
  text: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});
export type ThreadPredictionResult = typeof ThreadPredictionResult.Type;

export class ThreadPredictionError extends Schema.TaggedError<ThreadPredictionError>()(
  "ThreadPredictionError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not predict the next message.";
  }
}
