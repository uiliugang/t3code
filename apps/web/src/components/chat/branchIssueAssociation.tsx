import { createContext, useState, type PropsWithChildren } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

interface BranchIssueAssociationTarget {
  environmentId: EnvironmentId;
  cwd: string;
  branch: string;
}

export const BranchIssueAssociationContext = createContext<{
  target: BranchIssueAssociationTarget | null;
  setTarget: (target: BranchIssueAssociationTarget | null) => void;
} | null>(null);

export function BranchIssueAssociationProvider({ children }: PropsWithChildren) {
  const [target, setTarget] = useState<BranchIssueAssociationTarget | null>(null);
  return (
    <BranchIssueAssociationContext value={{ target, setTarget }}>
      {children}
    </BranchIssueAssociationContext>
  );
}
