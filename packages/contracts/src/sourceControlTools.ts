import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SourceControlToolId = Schema.Literals([
  "git",
  "github",
  "meituan",
  "ones2",
  "mcm",
  "mtskills",
]);
export type SourceControlToolId = typeof SourceControlToolId.Type;

export const SourceControlToolPhase = Schema.Literals([
  "idle",
  "running",
  "verifying",
  "succeeded",
  "unchanged",
  "failed",
]);

export const SourceControlTool = Schema.Struct({
  id: SourceControlToolId,
  label: TrimmedNonEmptyString,
  status: Schema.Literals(["installed", "missing", "unknown"]),
  version: Schema.NullOr(Schema.String),
  executablePath: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  manualCommand: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  phase: SourceControlToolPhase,
  message: Schema.NullOr(Schema.String),
});
export type SourceControlTool = typeof SourceControlTool.Type;

export const SourceControlToolStartInput = Schema.Struct({
  id: SourceControlToolId,
  expectedVersion: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  expectedPath: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  expectedCommand: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
});
export type SourceControlToolStartInput = typeof SourceControlToolStartInput.Type;

export class SourceControlToolError extends Schema.TaggedError<
  SourceControlToolError,
  { readonly brand: unique symbol }
>()("SourceControlToolError", {
  id: SourceControlToolId,
  reason: Schema.Literals([
    "busy",
    "changed",
    "unsupported",
    "inspection",
    "installation",
    "verification",
  ]),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "busy":
        return "Another tool installation is running on this environment.";
      case "changed":
        return "The installation changed. Refresh and confirm the new command.";
      case "unsupported":
        return "This installation must be managed on the server.";
      case "inspection":
        return "Could not inspect this tool on the server. Refresh and try again.";
      case "installation":
        return "The installer failed. Run the displayed command on the server for details.";
      case "verification":
        return "The active tool could not be verified. Check its installation and server PATH.";
    }
  }
}
