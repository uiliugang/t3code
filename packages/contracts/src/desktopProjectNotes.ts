import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProjectNote,
  ProjectNoteCreateInput,
  ProjectNoteListInput,
  ProjectNoteMutationResult,
  ProjectNotePage,
  ProjectNoteRef,
  ProjectNoteSearchInput,
  ProjectNoteSearchPage,
  ProjectNoteSetArchiveInput,
  ProjectNoteUpdateInput,
} from "./projectNotes.ts";

// Only the inherited desktop main/backend channel uses this contract; no public RPC.
export const DESKTOP_PROJECT_NOTES_PROTOCOL_VERSION = 1;
export const DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES = 1_600_000;
const requestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const DesktopProjectNotesLaunchNonce = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u),
);
export const DesktopProjectNotesCall = Schema.Union([
  Schema.TaggedStruct("list", { input: ProjectNoteListInput }),
  Schema.TaggedStruct("search", { input: ProjectNoteSearchInput }),
  Schema.TaggedStruct("get", { input: ProjectNoteRef }),
  Schema.TaggedStruct("create", { input: ProjectNoteCreateInput }),
  Schema.TaggedStruct("update", { input: ProjectNoteUpdateInput }),
  Schema.TaggedStruct("setArchive", { input: ProjectNoteSetArchiveInput }),
]);
export type DesktopProjectNotesCall = typeof DesktopProjectNotesCall.Type;
export const DesktopProjectNotesCallResult = Schema.Union([
  Schema.TaggedStruct("list", { value: ProjectNotePage }),
  Schema.TaggedStruct("search", { value: ProjectNoteSearchPage }),
  Schema.TaggedStruct("get", { value: ProjectNote }),
  Schema.TaggedStruct("create", { value: ProjectNoteMutationResult }),
  Schema.TaggedStruct("update", { value: ProjectNoteMutationResult }),
  Schema.TaggedStruct("setArchive", { value: ProjectNoteMutationResult }),
]);
export type DesktopProjectNotesCallResult = typeof DesktopProjectNotesCallResult.Type;
export const DesktopProjectNotesFailure = Schema.Struct({
  reason: Schema.Literals(["unavailable", "conflict", "mutation-reused", "too-large", "storage"]),
  currentRevision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type DesktopProjectNotesFailure = typeof DesktopProjectNotesFailure.Type;
export const DesktopProjectNotesPayload = Schema.Struct({
  environmentId: EnvironmentId,
  call: DesktopProjectNotesCall,
});
export type DesktopProjectNotesPayload = typeof DesktopProjectNotesPayload.Type;
export const DesktopProjectNotesOutcome = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: DesktopProjectNotesCallResult }),
  Schema.Struct({ ok: Schema.Literal(false), failure: DesktopProjectNotesFailure }),
]);
export type DesktopProjectNotesOutcome = typeof DesktopProjectNotesOutcome.Type;
const version = Schema.Literal(DESKTOP_PROJECT_NOTES_PROTOCOL_VERSION);
export const DesktopProjectNotesRequest = Schema.Union([
  Schema.TaggedStruct("open", { version, nonce: DesktopProjectNotesLaunchNonce }),
  Schema.TaggedStruct("call", { version, requestId, call: DesktopProjectNotesCall }),
]);
export type DesktopProjectNotesRequest = typeof DesktopProjectNotesRequest.Type;
export const DesktopProjectNotesReply = Schema.Union([
  Schema.TaggedStruct("ready", { version, environmentId: EnvironmentId }),
  Schema.TaggedStruct("result", { version, requestId, result: DesktopProjectNotesCallResult }),
  Schema.TaggedStruct("failure", { version, requestId, failure: DesktopProjectNotesFailure }),
]);
export type DesktopProjectNotesReply = typeof DesktopProjectNotesReply.Type;
