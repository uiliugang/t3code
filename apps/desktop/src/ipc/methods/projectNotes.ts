import { DesktopProjectNotesOutcome, DesktopProjectNotesPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DesktopBackendPool } from "../../backend/DesktopBackendPool.ts";
import { PRIMARY_INSTANCE_ID } from "../../backend/DesktopBackendManager.ts";
import type { DesktopIpcMethod } from "../DesktopIpc.ts";
import { GET_PROJECT_NOTES_ENVIRONMENT_CHANNEL, CALL_PROJECT_NOTES_CHANNEL } from "../channels.ts";

const primaryBackend = DesktopBackendPool.pipe(
  Effect.flatMap((pool) =>
    pool.list.pipe(
      Effect.map((instances) => instances.find((instance) => instance.id === PRIMARY_INSTANCE_ID)),
    ),
  ),
);
const unavailable = { ok: false, failure: { reason: "unavailable" } } as const;
const decode = Schema.decodeUnknownEffect(DesktopProjectNotesPayload, {
  onExcessProperty: "error",
});
const encode = Schema.encodeEffect(DesktopProjectNotesOutcome);
// DesktopIpc checks the actual app window/top frame before calling this method.
export const getProjectNotesEnvironment: DesktopIpcMethod<never, DesktopBackendPool> = {
  channel: GET_PROJECT_NOTES_ENVIRONMENT_CHANNEL,
  handler: (raw) =>
    raw === undefined
      ? primaryBackend.pipe(
          Effect.flatMap((backend) => backend?.projectNotesEnvironmentId ?? Effect.succeed(null)),
        )
      : Effect.succeed(null),
};
export const callProjectNotes: DesktopIpcMethod<never, DesktopBackendPool> = {
  channel: CALL_PROJECT_NOTES_CHANNEL,
  // Schema errors can contain private Markdown/search terms; never propagate them.
  handler: Effect.fn("desktop.ipc.projectNotes.call")(function* (raw: unknown) {
    const parsed = yield* decode(raw).pipe(Effect.option);
    if (Option.isNone(parsed)) return unavailable;
    const { environmentId, call } = parsed.value;
    const backend = yield* primaryBackend;
    if (
      backend?.callProjectNotes === undefined ||
      backend.projectNotesEnvironmentId === undefined ||
      (yield* backend.projectNotesEnvironmentId) !== environmentId
    )
      return unavailable;
    const outcome = yield* backend.callProjectNotes(environmentId, call);
    return yield* encode(outcome).pipe(Effect.orElseSucceed(() => unavailable));
  }),
};
