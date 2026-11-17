import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/rpc/RpcClientError";

const isRpcClientError = Schema.is(RpcClientError);

export function threadForkFailure(cause: Cause.Cause<unknown>) {
  if (Cause.hasInterruptsOnly(cause)) return null;
  const error = Cause.squash(cause);
  if (isRpcClientError(error)) {
    return {
      title: "Could not confirm fork",
      message: "Reconnect and check the thread list before trying again.",
    };
  }
  return {
    title: "Could not start task",
    message:
      error instanceof Error && error.message.trim() ? error.message : "Something went wrong.",
  };
}
