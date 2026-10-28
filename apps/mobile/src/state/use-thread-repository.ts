import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ExecutionResourceId,
  EnvironmentId,
  ThreadRepositoryTarget,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import { useThreadSelection } from "./use-thread-selection";

const selection = Atom.family((key: string) =>
  Atom.make<ExecutionResourceId | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`repository:${key}`),
  ),
);

export type ThreadRepositorySelection =
  | ExecutionResourceId
  | (ThreadRepositoryTarget & { readonly environmentId: EnvironmentId });

export function useThreadRepository(override?: ThreadRepositorySelection) {
  const { selectedThread } = useThreadSelection();
  const workspace = selectedThread?.workspace;
  const key = selectedThread
    ? `${scopedThreadKey({ environmentId: selectedThread.environmentId, threadId: selectedThread.id })}:${workspace?.id ?? "legacy"}`
    : "none";
  const selected = useAtomValue(selection(key));
  const primary = workspace?.bindings.find(
    (binding) => binding.rootId === workspace.primaryRootId,
  )?.resourceId;
  const overrideId = typeof override === "string" ? override : override?.resourceId;
  const matchesRevision =
    typeof override !== "object" ||
    (override.workspaceRevisionId === workspace?.id &&
      override.threadId === selectedThread?.id &&
      override.environmentId === selectedThread?.environmentId);
  const repository = matchesRevision
    ? (workspace?.resources.find((resource) => resource.id === (overrideId ?? selected)) ??
      (override === undefined
        ? workspace?.resources.find((resource) => resource.id === primary)
        : undefined))
    : undefined;
  const repositoryTarget =
    selectedThread && workspace && repository
      ? {
          threadId: selectedThread.id,
          workspaceRevisionId: workspace.id,
          resourceId: repository.id,
        }
      : undefined;
  return {
    workspace,
    repository,
    repositoryTarget,
    selectionTarget:
      repositoryTarget && selectedThread
        ? { ...repositoryTarget, environmentId: selectedThread.environmentId }
        : undefined,
    selectRepository: (id: ExecutionResourceId) => appAtomRegistry.set(selection(key), id),
  };
}
