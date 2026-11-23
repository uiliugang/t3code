import type { DesktopProjectNotesOutcome } from "@t3tools/contracts";

export function noteMutationUnconfirmed(
  outcome: DesktopProjectNotesOutcome,
  method: "create" | "update",
): boolean {
  // The pipe can lose the reply after SQLite commits.
  return outcome.ok ? outcome.result._tag !== method : outcome.failure.reason === "unavailable";
}
