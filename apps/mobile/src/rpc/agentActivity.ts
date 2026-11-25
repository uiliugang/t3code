import { scopeRequiredError } from "@t3tools/client-runtime/rpc";
import type { ClientCapabilities } from "@t3tools/client-runtime/platform";
import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  WsServerGetAgentActivityRpc,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

const activityRpc = RpcGroup.make(WsServerGetAgentActivityRpc);
export const fetchNoiseAgentActivity = Effect.fn("MobileWake.fetchAgentActivity")(function* (
  approved: ClientCapabilities.ApprovedNoiseConnection,
) {
  if (!sessionGrantsScope(approved.authSessionState, AuthOrchestrationReadScope))
    return yield* scopeRequiredError(AuthOrchestrationReadScope);
  const protocol = RpcClient.layerProtocolSocket({
    retryTransientErrors: false,
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Layer.provide(Layer.succeed(Socket.Socket, approved.socket)),
    Layer.provide(RpcSerialization.layerJson),
  );
  return yield* RpcClient.make(activityRpc).pipe(
    Effect.flatMap((client) => client[WsServerGetAgentActivityRpc._tag]({})),
    Effect.provide(protocol),
  );
});
