import * as Schema from "effect/Schema";
import { ThreadId, ProjectId } from "./baseSchemas.ts";

export class WechatError extends Schema.TaggedError<
  WechatError,
  { readonly brand: unique symbol }
>()("WechatError", {
  reason: Schema.Literals([
    "network",
    "protocol",
    "credentials",
    "storage",
    "target",
    "unpaired",
    "busy",
  ]),
}) {
  override get message() {
    return `WeChat operation failed: ${this.reason}.`;
  }
}

export const WechatDelivery = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pending", "sending", "sent", "failed", "unknown"]),
  preview: Schema.String,
  createdAt: Schema.Number,
  attempts: Schema.Number,
});
export const WechatState = Schema.Struct({
  status: Schema.Literals([
    "unpaired",
    "waiting",
    "scanned",
    "verify",
    "expired",
    "connected",
    "offline",
    "reconnect_required",
  ]),
  enabled: Schema.Boolean,
  activated: Schema.Boolean,
  botId: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  pushEnabled: Schema.Boolean,
  pushAllThreads: Schema.Boolean,
  qrCode: Schema.NullOr(Schema.String),
  bindingCode: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(WechatError.fields.reason),
  deliveries: Schema.Array(WechatDelivery),
  targets: Schema.Array(
    Schema.Struct({ threadId: ThreadId, projectId: ProjectId, title: Schema.String }),
  ),
});
export type WechatState = typeof WechatState.Type;

export const WechatMutation = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["connect", "cancel", "unlink", "test"]) }),
  Schema.Struct({
    type: Schema.Literal("verify"),
    code: Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)),
  }),
  Schema.Struct({ type: Schema.Literal("enabled"), enabled: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("configure"),
    threadId: ThreadId,
    pushEnabled: Schema.Boolean,
    pushAllThreads: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("retry"), deliveryId: Schema.String }),
]);
export type WechatMutation = typeof WechatMutation.Type;
export const WechatSendInput = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)),
});
