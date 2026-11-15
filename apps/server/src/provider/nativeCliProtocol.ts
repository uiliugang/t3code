import * as Schema from "effect/Schema";

export const Request = Schema.Struct({
  command: Schema.Literals(["codex", "claude"]),
  threadId: Schema.optional(Schema.NonEmptyString),
  instanceId: Schema.optional(Schema.NonEmptyString),
  args: Schema.Array(Schema.String),
});
export const Response = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    command: Schema.NonEmptyString,
    args: Schema.Array(Schema.String),
    environment: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);
export const FRAME_BYTES = 1024 * 1024;
export const TIMEOUT_MS = 30_000;
export const DESCRIPTOR = "native-cli.json";
