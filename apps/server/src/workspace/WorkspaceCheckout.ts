import {
  CommandId,
  ThreadWorkspaceRevision,
  WorkspaceCheckoutError,
  WorkspaceRevisionId,
  type WorkspaceCheckoutInput,
  type WorkspaceCheckoutResult,
} from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

export class WorkspaceCheckout extends Context.Service<
  WorkspaceCheckout,
  {
    readonly bind: (
      input: WorkspaceCheckoutInput,
    ) => Effect.Effect<WorkspaceCheckoutResult, WorkspaceCheckoutError>;
  }
>()("t3/workspace/WorkspaceCheckout") {}

const isWorkspaceCheckoutError = Schema.is(WorkspaceCheckoutError);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const status = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;

  return WorkspaceCheckout.of({
    bind: Effect.fn("WorkspaceCheckout.bind")(
      function* (input) {
        return yield* withWorkspaceLease(
          `prepare:${input.threadId}`,
          Effect.gen(function* () {
            const readCurrent = Effect.fn("WorkspaceCheckout.readCurrent")(function* (
              changingCheckout: boolean,
            ) {
              const current = yield* threads.getThreadRecords(input.threadId, [
                "runs",
                "providerSessions",
                "runtimeRequests",
              ]);
              if (
                current.thread.worktreePath !== input.expectedWorktreePath ||
                (current.thread.workspace?.id ?? null) !== input.expectedWorkspaceRevisionId
              ) {
                return yield* new WorkspaceCheckoutError({
                  detail: "The task checkout changed. Refresh and try again.",
                });
              }
              if (
                current.thread.deletedAt !== null ||
                current.thread.archivedAt !== null ||
                (changingCheckout &&
                  (current.runs.some((run) =>
                    ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
                  ) ||
                    current.runtimeRequests.some((request) => request.status === "pending")))
              ) {
                return yield* new WorkspaceCheckoutError({
                  detail: "Stop the task and cancel queued messages before changing its checkout.",
                });
              }
              return current;
            });
            const { thread } = yield* readCurrent(false);
            const workspace = thread.workspace;
            const resource = workspace?.resources.find((item) => item.id === input.resourceId);
            if ((workspace && !resource) || (!workspace && input.resourceId !== undefined)) {
              return yield* new WorkspaceCheckoutError({
                detail: "Select a repository from the task's current group.",
              });
            }
            const project = workspace ? null : yield* projects.getById(thread.projectId);
            if (project && Option.isNone(project)) {
              return yield* new WorkspaceCheckoutError({
                detail: "The task's project no longer exists.",
              });
            }
            const projectRoot =
              project && Option.isSome(project)
                ? (thread.projectWorkspaceRoot ?? project.value.workspaceRoot)
                : null;
            const previous =
              resource?.identity ?? (yield* resolver.inspect(thread.worktreePath ?? projectRoot!));
            if (resource) yield* resolver.verify(resource.identity);
            const checkout = yield* resolver.inspect(input.cwd);
            if (
              checkout.commonDir !== previous.commonDir ||
              checkout.commonDirIdentity !== previous.commonDirIdentity
            ) {
              return yield* new WorkspaceCheckoutError({
                detail: "The selected checkout belongs to another repository.",
              });
            }
            const branch = yield* git.resolveBranchName(checkout.checkoutRoot, "HEAD");
            const changingCheckout =
              checkout.gitDir !== previous.gitDir ||
              checkout.gitDirIdentity !== previous.gitDirIdentity;
            const current = yield* readCurrent(changingCheckout);
            const commandId = CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
            let worktreePath: string | null = checkout.checkoutRoot;

            if (!workspace) {
              const source = yield* resolver.inspect(projectRoot!);
              worktreePath =
                checkout.checkoutRoot === source.checkoutRoot ? null : checkout.checkoutRoot;
              const latest = yield* readCurrent(worktreePath !== current.thread.worktreePath);
              if (latest.thread.branch !== branch || latest.thread.worktreePath !== worktreePath) {
                yield* threads.dispatch({
                  type: "thread.metadata.update",
                  commandId,
                  threadId: input.threadId,
                  branch,
                  worktreePath,
                  expectedWorktreePath: input.expectedWorktreePath,
                  expectedBranch: latest.thread.branch,
                });
              }
            } else if (!changingCheckout) {
              const isPrimary = workspace.bindings.some(
                (binding) =>
                  binding.rootId === workspace.primaryRootId && binding.resourceId === resource!.id,
              );
              if (isPrimary && current.thread.branch !== branch) {
                yield* threads.dispatch({
                  type: "thread.metadata.update",
                  commandId,
                  threadId: input.threadId,
                  branch,
                  expectedWorktreePath: input.expectedWorktreePath,
                  expectedBranch: current.thread.branch,
                });
              }
            } else {
              const bindings = workspace.bindings.filter(
                (binding) => binding.resourceId === resource!.id,
              );
              const resolved = yield* resolver.resolve({
                primaryRootId: bindings[0]!.rootId,
                roots: bindings.map((binding) => ({
                  id: binding.rootId,
                  alias: binding.alias,
                  description: binding.description,
                  accessIntent: binding.accessIntent,
                  defaultSelected: true,
                  sourcePath: path.join(checkout.checkoutRoot, binding.relativeSubpath),
                })),
              });
              const replacement = resolved.resources[0]!;
              if (
                resolved.resources.length !== 1 ||
                replacement.identity.gitDir !== checkout.gitDir ||
                replacement.identity.gitDirIdentity !== checkout.gitDirIdentity ||
                workspace.resources.some(
                  (other) =>
                    other.id !== resource!.id &&
                    (workspaceRelativeFilePath(replacement.checkoutRoot, other.checkoutRoot) !==
                      null ||
                      workspaceRelativeFilePath(other.checkoutRoot, replacement.checkoutRoot) !==
                        null),
                )
              ) {
                return yield* new WorkspaceCheckoutError({
                  detail: "The selected checkout conflicts with another repository in the group.",
                });
              }
              const primaryBinding = workspace.bindings.find(
                (binding) => binding.rootId === workspace.primaryRootId,
              )!;
              const changesPrimary = primaryBinding.resourceId === resource!.id;
              const primaryResource = workspace.resources.find(
                (item) => item.id === primaryBinding.resourceId,
              )!;
              const primaryBranch = changesPrimary
                ? branch
                : yield* git.resolveBranchName(primaryResource.checkoutRoot, "HEAD");
              const source = changesPrimary
                ? yield* resolver.inspect(primaryBinding.sourcePathAtBind)
                : null;
              const revision = ThreadWorkspaceRevision.make({
                ...workspace,
                id: WorkspaceRevisionId.make(commandId),
                previousRevisionId: workspace.id,
                mode: source
                  ? checkout.checkoutRoot === source.checkoutRoot
                    ? "existing"
                    : "isolated"
                  : workspace.mode,
                createdAt: DateTime.formatIso(yield* DateTime.now),
                resources: workspace.resources.map((item) =>
                  item.id === resource!.id ? replacement : item,
                ),
                bindings: workspace.bindings.map((binding) =>
                  binding.resourceId === resource!.id
                    ? {
                        ...binding,
                        resourceId: replacement.id,
                        executionPath: path.join(replacement.checkoutRoot, binding.relativeSubpath),
                        launchBranch: branch,
                      }
                    : binding.rootId === workspace.primaryRootId
                      ? { ...binding, launchBranch: primaryBranch }
                      : binding,
                ),
              });
              const latest = yield* readCurrent(true);
              for (const session of latest.providerSessions) {
                yield* sessions.detach({
                  providerSessionId: session.id,
                  threadId: input.threadId,
                  revokeMcpCredential: true,
                });
                yield* threads.dispatch({
                  type: "provider-session.detach",
                  commandId: CommandId.make(`${commandId}:detach:${session.id}`),
                  threadId: input.threadId,
                  providerSessionId: session.id,
                  reason: "Group checkout changed",
                });
              }
              yield* threads.dispatch({
                type: "thread.workspace.bind",
                commandId,
                threadId: input.threadId,
                expectedWorkspaceRevisionId: workspace.id,
                workspace: revision,
              });
            }
            yield* status
              .refreshLocalStatus(checkout.checkoutRoot)
              .pipe(Effect.ignore({ log: true }));
            return { branch, worktreePath };
          }),
        );
      },
      Effect.mapError((cause) =>
        isWorkspaceCheckoutError(cause)
          ? cause
          : new WorkspaceCheckoutError({
              detail: "Could not bind the task to the selected checkout.",
              cause,
            }),
      ),
    ),
  });
});

export const layer = Layer.effect(WorkspaceCheckout, make);
