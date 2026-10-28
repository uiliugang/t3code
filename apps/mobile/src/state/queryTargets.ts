import type { EnvironmentId, ThreadId, ThreadRepositoryTarget } from "@t3tools/contracts";

export interface CheckpointDiffTarget {
  readonly repositoryTarget?: ThreadRepositoryTarget;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
}

export function normalizeComposerPathSearchQuery(query: string | null): string {
  return query?.trim() ?? "";
}

export function buildCheckpointDiffTargets(target: CheckpointDiffTarget) {
  if (
    target.environmentId === null ||
    target.threadId === null ||
    target.fromTurnCount === null ||
    target.toTurnCount === null
  ) {
    return { fullThread: null, turn: null } as const;
  }

  if (target.fromTurnCount === 0) {
    return {
      fullThread: {
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          ...(target.repositoryTarget === undefined
            ? {}
            : { repositoryTarget: target.repositoryTarget }),
          toTurnCount: target.toTurnCount,
          ignoreWhitespace: target.ignoreWhitespace,
        },
      },
      turn: null,
    } as const;
  }

  return {
    fullThread: null,
    turn: {
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        ...(target.repositoryTarget === undefined
          ? {}
          : { repositoryTarget: target.repositoryTarget }),
        fromTurnCount: target.fromTurnCount,
        toTurnCount: target.toTurnCount,
        ignoreWhitespace: target.ignoreWhitespace,
      },
    },
  } as const;
}
