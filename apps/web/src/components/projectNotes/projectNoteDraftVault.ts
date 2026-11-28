import type { DesktopBridge, EnvironmentId, ProjectId, ProjectNote } from "@t3tools/contracts";
import { isDirtyNoteDraft, type NoteDraft } from "./projectNoteDraft";

type Bridge = Pick<DesktopBridge, "getProjectNotesEnvironment">;
type CachedProjectDraft = { readonly lease: object; draft: NoteDraft | null };
type Drafts = Map<EnvironmentId, Map<ProjectId, CachedProjectDraft>>;
// Retained only in the trusted native renderer, never in shared browser storage.
const vaults = new WeakMap<Bridge, Drafts>();
type RestoredDraft =
  | { readonly available: true; readonly draft: NoteDraft | null }
  | { readonly available: false };
export type ConfirmedProjectNoteDrafts = {
  readonly restorePending: (
    read: (id: NoteDraft["id"]) => Promise<ProjectNote | null>,
  ) => Promise<RestoredDraft>;
  readonly retain: (draft: NoteDraft | null) => void;
};
export async function confirmProjectNoteDrafts(
  bridge: Bridge,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<ConfirmedProjectNoteDrafts | null> {
  if ((await bridge.getProjectNotesEnvironment?.().catch(() => null)) !== environmentId)
    return null;
  let owner = vaults.get(bridge);
  if (owner === undefined) {
    owner = new Map();
    vaults.set(bridge, owner);
  }
  let projectDrafts = owner.get(environmentId);
  if (projectDrafts === undefined) {
    projectDrafts = new Map();
    owner.set(environmentId, projectDrafts);
  }
  const lease = {};
  const scope: CachedProjectDraft = { lease, draft: projectDrafts.get(projectId)?.draft ?? null };
  const scoped = projectDrafts;
  scoped.set(projectId, scope);
  const current = () => scoped.get(projectId)?.lease === lease;
  return {
    restorePending: async (read) => {
      if (!current()) return { available: false };
      const draft = scope.draft;
      if (!draft) return { available: true, draft: null };
      const saved = await read(draft.id);
      if (
        !current() ||
        draft !== scope.draft ||
        !saved ||
        saved.projectId !== projectId ||
        saved.id !== draft.id ||
        saved.revision < draft.base.revision
      )
        return { available: false };
      return {
        available: true,
        draft:
          saved.revision > draft.base.revision
            ? { ...draft, conflictingRevision: saved.revision }
            : draft,
      };
    },
    retain: (draft) => {
      if (
        !current() ||
        (draft !== null &&
          (draft.projectId !== projectId || draft.clientScopeKey !== environmentId))
      )
        return;
      scope.draft = draft === null || !isDirtyNoteDraft(draft) ? null : draft;
    },
  };
}
