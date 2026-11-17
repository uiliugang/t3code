import { expect, it } from "vite-plus/test";
import {
  CommandId,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2ThreadLaunchError,
  ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { SocketCloseError } from "effect/socket/Socket";

import { threadForkFailure } from "./threadForkFailure";

it.each([
  new OrchestrationV2DispatchCommandError({
    commandId: CommandId.make("fork-current"),
    commandType: "thread.fork",
    message: "The source response is not available for forking.",
  }),
  new OrchestrationV2ThreadLaunchError({
    commandId: CommandId.make("fork-worktree"),
    projectId: ProjectId.make("project"),
    message: "Resolve merge conflicts before forking this workspace.",
  }),
])("preserves a rejected fork's reason: $message", (error) => {
  expect(threadForkFailure(Cause.fail(error))).toEqual({
    title: "Could not start task",
    message: error.message,
  });
});

it("keeps an unacknowledged fork uncertain and ignores cancellation", () => {
  const error = new RpcClientError({
    reason: new SocketCloseError({ code: 1006 }),
  });
  expect(threadForkFailure(Cause.fail(error))).toEqual({
    title: "Could not confirm fork",
    message: "Reconnect and check the thread list before trying again.",
  });
  expect(threadForkFailure(Cause.interrupt())).toBeNull();
});

it("uses a failure fallback when no useful error message is available", () => {
  for (const error of [undefined, new Error(" ")]) {
    expect(threadForkFailure(Cause.die(error))).toEqual({
      title: "Could not start task",
      message: "Something went wrong.",
    });
  }
});
