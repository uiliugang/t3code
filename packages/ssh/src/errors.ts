import * as Schema from "effect/Schema";

export class SshHostDiscoveryError extends Schema.TaggedError<
  SshHostDiscoveryError,
  { readonly brand: unique symbol }
>()("SshHostDiscoveryError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class SshInvalidTargetError extends Schema.TaggedError<
  SshInvalidTargetError,
  { readonly brand: unique symbol }
>()("SshInvalidTargetError", {
  message: Schema.String,
}) {}

export class SshCommandError extends Schema.TaggedError<
  SshCommandError,
  { readonly brand: unique symbol }
>()("SshCommandError", {
  message: Schema.String,
  command: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  stdout: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SshLaunchError extends Schema.TaggedError<
  SshLaunchError,
  { readonly brand: unique symbol }
>()("SshLaunchError", {
  message: Schema.String,
  stdout: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SshPairingError extends Schema.TaggedError<
  SshPairingError,
  { readonly brand: unique symbol }
>()("SshPairingError", {
  message: Schema.String,
  stdout: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SshHttpBridgeError extends Schema.TaggedError<
  SshHttpBridgeError,
  { readonly brand: unique symbol }
>()("SshHttpBridgeError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SshReadinessError extends Schema.TaggedError<
  SshReadinessError,
  { readonly brand: unique symbol }
>()("SshReadinessError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SshPasswordPromptError extends Schema.TaggedError<
  SshPasswordPromptError,
  { readonly brand: unique symbol }
>()("SshPasswordPromptError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
