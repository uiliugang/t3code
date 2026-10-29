import type {
  EnvironmentId,
  ThreadRepositoryTarget,
  VcsRef as ContractVcsRef,
} from "@t3tools/contracts";

export interface VcsRefTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
  readonly repositoryTarget?: ThreadRepositoryTarget;
}

export type VcsRef = ContractVcsRef;
