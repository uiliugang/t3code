import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WorktreeRecreateError extends Schema.TaggedError<
  WorktreeRecreateError,
  { readonly brand: unique symbol }
>()("WorktreeRecreateError", {
  worktreePath: Schema.String,
  branch: Schema.String,
  cause: Schema.Defect(),
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return (
      this.detail ??
      `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`
    );
  }
}

export class WorktreeRecreateNoBaseError extends Schema.TaggedError<
  WorktreeRecreateNoBaseError,
  { readonly brand: unique symbol }
>()("WorktreeRecreateNoBaseError", { worktreePath: Schema.String, branch: Schema.String }) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: no permitted base branch is available.`;
  }
}

export class WorktreeMetadataMissingError extends Schema.TaggedError<
  WorktreeMetadataMissingError,
  { readonly brand: unique symbol }
>()("WorktreeMetadataMissingError", { worktreePath: Schema.String }) {
  override get message(): string {
    return "Worktree metadata is missing. Files in this directory were retained. Inspect the directory before continuing.";
  }
}

export interface RecreatedWorktree {
  readonly project: Project;
  readonly worktreePath: string;
  readonly setupStarted?: true;
  readonly setupCompleted?: true;
}

export type WorktreeThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "worktreePath" | "branch" | "workspace"
> &
  Partial<
    Pick<OrchestrationV2ThreadShell, "lineage" | "delegatedFrom" | "forkedFrom" | "linkOrigin">
  >;

export type RecreatedWorktreeAction =
  | { readonly action?: "take" | "peek" }
  | { readonly action: "start-setup" | "reset-setup"; readonly worktreePath: string }
  | {
      readonly action: "clear";
      readonly worktreePath?: string;
      readonly setupCompleted?: true;
    }
  | {
      readonly action: "record";
      readonly projectId: ProjectId;
      readonly worktreePath: string;
      readonly project?: Project;
    };

export class ThreadWorktreeRestore extends Context.Service<
  ThreadWorktreeRestore,
  {
    readonly restore: (
      thread: WorktreeThread,
    ) => Effect.Effect<
      void,
      WorktreeRecreateError | WorktreeRecreateNoBaseError | WorktreeMetadataMissingError
    >;
    readonly takeRecreated: (
      threadId: ThreadId,
      options?: RecreatedWorktreeAction,
    ) => Effect.Effect<RecreatedWorktree | undefined, WorktreeRecreateError>;
  }
>()("t3/workspace/ThreadWorktreeRestore") {}
