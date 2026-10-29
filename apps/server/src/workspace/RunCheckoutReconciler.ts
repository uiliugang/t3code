import type { OrchestrationV2CheckpointScope, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as WorkspaceCheckout from "./WorkspaceCheckout.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import { gitCheckoutChanges } from "./gitCheckoutCommand.ts";

interface RunCheckoutReconcilerShape {
  readonly reconcile: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scope: Pick<
      OrchestrationV2CheckpointScope,
      "runId" | "kind" | "cwd" | "workspace"
    > | null;
  }) => Effect.Effect<ReadonlyArray<string>>;
}

export class RunCheckoutReconciler extends Context.Reference<RunCheckoutReconcilerShape>(
  "t3/workspace/RunCheckoutReconciler",
  {
    defaultValue: () => ({ reconcile: () => Effect.succeed([]) }),
  },
) {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const checkout = yield* WorkspaceCheckout.WorkspaceCheckout;
  const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
  const path = yield* Path.Path;

  return {
    reconcile: Effect.fn("RunCheckoutReconciler.reconcile")(
      function* ({ threadId, runId, scope }) {
        if (!scope || scope.kind !== "root_run" || scope.runId !== runId) return [];
        let expected = yield* projections.getThreadShell(threadId);
        if (
          !expected ||
          expected.deletedAt !== null ||
          expected.archivedAt !== null ||
          expected.latestRunId !== runId ||
          (expected.activeRunId !== null && expected.activeRunId !== runId) ||
          (expected.workspace?.id ?? null) !== (scope.workspace?.id ?? null)
        )
          return [];
        const original = scope.workspace ? null : yield* resolver.inspect(scope.cwd);
        const targets = scope.workspace
          ? scope.workspace.resources.map((resource) => ({
              resourceId: resource.id,
              identity: resource.identity,
              currentIdentity: resource.identity,
              checkoutPath: resource.checkoutRoot,
            }))
          : [
              {
                resourceId: undefined,
                identity: original!,
                currentIdentity: original!,
                checkoutPath: scope.cwd,
              },
            ];
        if (!scope.workspace) {
          const bound = yield* resolver.inspect(
            expected.worktreePath ?? expected.projectWorkspaceRoot ?? scope.cwd,
          );
          if (
            bound.gitDir !== targets[0]!.identity.gitDir ||
            bound.gitDirIdentity !== targets[0]!.identity.gitDirIdentity
          )
            return [];
          targets[0]!.checkoutPath = bound.checkoutRoot;
        }
        const records = yield* projections.getThreadRecords(
          threadId,
          ["runs", "nodes", "turnItems"],
          {
            runIds: [runId],
            nodeRunIds: [runId],
            turnItemRunIds: [runId],
            turnItemTypes: ["command_execution"],
            turnItemStatuses: ["completed"],
          },
        );
        const run = records.runs.find((item) => item.id === runId);
        if (!run) return [];
        const nodes = new Map(records.nodes.map((node) => [node.id, node]));
        for (const item of records.turnItems.toSorted(
          (left, right) => left.ordinal - right.ordinal,
        )) {
          if (
            item.type !== "command_execution" ||
            item.runId !== runId ||
            item.status !== "completed" ||
            (item.exitCode !== undefined && item.exitCode !== 0) ||
            item.outputIndicatesFailure ||
            (item.providerThreadId !== null &&
              run.providerThreadId !== null &&
              item.providerThreadId !== run.providerThreadId)
          )
            continue;
          let rootCommand = item.nodeId === null && item.parentItemId === null;
          let nodeId = item.nodeId;
          const visited = new Set<typeof nodeId>();
          while (nodeId !== null && !visited.has(nodeId)) {
            visited.add(nodeId);
            const node = nodes.get(nodeId);
            if (!node || node.kind === "subagent" || node.runId !== runId) break;
            if (node.id === run.rootNodeId) {
              rootCommand = true;
              break;
            }
            nodeId = node.parentNodeId;
          }
          if (!rootCommand) continue;
          for (const change of gitCheckoutChanges(item.input, item.cwd ?? scope.cwd, path)) {
            const from = yield* resolver.inspect(change.cwd).pipe(Effect.option);
            if (Option.isNone(from)) continue;
            const candidates = targets.filter(
              (target) =>
                target.identity.commonDir === from.value.commonDir &&
                target.identity.commonDirIdentity === from.value.commonDirIdentity,
            );
            const exact = candidates.filter((target) =>
              [target.identity, target.currentIdentity].some(
                (identity) =>
                  identity.gitDir === from.value.gitDir &&
                  identity.gitDirIdentity === from.value.gitDirIdentity,
              ),
            );
            const target =
              exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
            if (!target) continue;
            const to = yield* resolver.inspect(change.checkoutPath).pipe(Effect.option);
            if (
              Option.isNone(to) ||
              to.value.commonDir !== target.identity.commonDir ||
              to.value.commonDirIdentity !== target.identity.commonDirIdentity
            )
              continue;
            target.checkoutPath = to.value.checkoutRoot;
            target.currentIdentity = to.value;
          }
        }
        const refreshed: Array<string> = [];
        for (const target of targets) {
          const current = yield* projections.getThreadShell(threadId);
          if (
            !current ||
            current.latestRunId !== runId ||
            (current.activeRunId !== null && current.activeRunId !== runId) ||
            current.worktreePath !== expected.worktreePath ||
            current.branch !== expected.branch ||
            (current.workspace?.id ?? null) !== (expected.workspace?.id ?? null)
          )
            break;
          yield* checkout.bind({
            threadId,
            cwd: target.checkoutPath,
            expectedWorktreePath: current.worktreePath,
            expectedWorkspaceRevisionId: current.workspace?.id ?? null,
            ...(target.resourceId === undefined ? {} : { resourceId: target.resourceId }),
          });
          if (target.checkoutPath !== target.identity.checkoutRoot)
            refreshed.push(target.checkoutPath);
          const next = yield* projections.getThreadShell(threadId);
          if (!next) break;
          if (current.workspace && next.workspace?.id !== current.workspace.id) {
            if (
              next.workspace?.previousRevisionId !== current.workspace.id ||
              current.workspace.resources.some(
                (resource) =>
                  resource.id !== target.resourceId &&
                  !next.workspace?.resources.some(
                    (other) =>
                      other.id === resource.id && other.checkoutRoot === resource.checkoutRoot,
                  ),
              )
            )
              break;
            const selected = current.workspace.bindings.find(
              (binding) => binding.resourceId === target.resourceId,
            );
            const rebound = next.workspace.bindings.find(
              (binding) => binding.rootId === selected?.rootId,
            );
            if (
              !next.workspace.resources.some(
                (resource) =>
                  resource.id === rebound?.resourceId &&
                  resource.checkoutRoot === target.checkoutPath,
              )
            )
              break;
          }
          expected = next;
        }
        return refreshed;
      },
      (effect, input) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to reconcile agent checkout changes", {
              threadId: input.threadId,
              runId: input.runId,
              cause,
            }).pipe(Effect.as([])),
          ),
        ),
    ),
  } satisfies RunCheckoutReconcilerShape;
});

export const layer = Layer.effect(RunCheckoutReconciler, make);
