import * as Schema from "effect/Schema";

export class ProviderInstanceNotFoundError extends Schema.TaggedError<
  ProviderInstanceNotFoundError,
  { readonly brand: unique symbol }
>()("ProviderInstanceNotFoundError", {
  instanceId: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

export { ProviderDriverError } from "@t3tools/provider-core/server/errors";

export class ProviderWorkspaceMissingError extends Schema.TaggedError<
  ProviderWorkspaceMissingError,
  { readonly brand: unique symbol }
>()("ProviderWorkspaceMissingError", {
  threadId: Schema.String,
  cwd: Schema.String,
}) {
  override get message(): string {
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. Restore the folder at this path before retrying.`;
  }
}
