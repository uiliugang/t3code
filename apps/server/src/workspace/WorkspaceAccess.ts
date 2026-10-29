import * as WorkspaceRestore from "./WorkspaceRestore.ts";
import * as Option from "effect/Option";
import { withWorkspaceLease } from "./workspaceLease.ts";
import { GitCommandError, type ThreadId, type ThreadRepositoryTarget } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";

export class WorkspaceAccess extends Context.Service<
  WorkspaceAccess,
  {
    readonly run: <A, E, R>(
      input: {
        readonly cwd: string;
        readonly threadId?: ThreadId | undefined;
        readonly repositoryTarget?: ThreadRepositoryTarget | undefined;
      },
      operation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitCommandError, R>;
    readonly validate: (
      input: {
        readonly cwd: string;
        readonly threadId?: ThreadId | undefined;
        readonly repositoryTarget?: ThreadRepositoryTarget | undefined;
      },
      write?: boolean,
    ) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/workspace/WorkspaceAccess") {}

export const layer = Layer.effect(
  WorkspaceAccess,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const recovery = yield* Effect.serviceOption(WorkspaceRestore.WorkspaceRestore);
    const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const validate: WorkspaceAccess["Service"]["validate"] = Effect.fn("WorkspaceAccess.validate")(
      function* (input, write = true) {
        const reject = (detail: string) =>
          new GitCommandError({
            operation: "WorkspaceAccess.validate",
            command: "git",
            cwd: input.cwd,
            detail,
          });
        const target = input.repositoryTarget;
        if (
          target !== undefined &&
          input.threadId !== undefined &&
          input.threadId !== target.threadId
        )
          return yield* reject("The repository action belongs to a different task.");
        if (target === undefined) {
          if (!write) return;
          const shell = yield* threads.getShellSnapshot();
          const cwd = yield* fs.realPath(input.cwd);
          if (
            [...shell.threads, ...shell.archivedThreads].some((thread) =>
              thread.workspace?.resources.some(
                (resource) =>
                  resource.checkoutRoot === cwd ||
                  (path.relative(resource.checkoutRoot, cwd) !== ".." &&
                    !path.relative(resource.checkoutRoot, cwd).startsWith(`..${path.sep}`) &&
                    !path.isAbsolute(path.relative(resource.checkoutRoot, cwd))),
              ),
            )
          )
            return yield* reject(
              "Select a repository from the task workspace. This client did not supply a workspace revision.",
            );
          return;
        }
        const projection = yield* threads.getThreadRecords(target.threadId, ["runs"]);
        const workspace = projection.thread.workspace;
        const resource = workspace?.resources.find((entry) => entry.id === target.resourceId);
        if (
          workspace?.id !== target.workspaceRevisionId ||
          resource === undefined ||
          projection.thread.deletedAt !== null
        )
          return yield* reject("The task workspace changed. Reopen this repository action.");
        if ((yield* fs.realPath(input.cwd)) !== resource.checkoutRoot)
          return yield* reject(
            "The repository path does not match the selected workspace resource.",
          );
        if (
          write &&
          (workspace.bindings.some(
            (binding) => binding.resourceId === resource.id && binding.accessIntent !== "write",
          ) ||
            projection.runs.some((run) =>
              ["preparing", "starting", "running", "waiting"].includes(run.status),
            ))
        )
          return yield* reject("Wait for this task to stop before changing its repository.");
        if (write && Option.isSome(recovery))
          yield* recovery.value.assertReady(target.threadId, workspace);
        yield* resolver.verify(resource.identity);
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "WorkspaceAccess.validate",
                command: "git",
                cwd: input.cwd,
                detail: cause instanceof Error ? cause.message : "Repository validation failed.",
                cause,
              }),
          ),
        ),
    );
    return WorkspaceAccess.of({
      validate,
      run: Effect.fn("WorkspaceAccess.run")((input, operation) =>
        validate(input).pipe(
          Effect.andThen(
            input.repositoryTarget === undefined
              ? operation
              : withWorkspaceLease(
                  `resource:${input.repositoryTarget.resourceId}`,
                  validate(input).pipe(Effect.andThen(operation)),
                ),
          ),
        ),
      ),
    });
  }),
);
