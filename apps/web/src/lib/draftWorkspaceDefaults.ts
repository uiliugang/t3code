import type { ScopedProjectRef } from "@t3tools/contracts";
import { flushSync } from "react-dom";

import { applyPendingDraftWorkspaceUpdate } from "../components/chat/preparingComposerImages";
import { type DraftId, type DraftSessionState, useComposerDraftStore } from "../composerDraftStore";

type DraftWorkspaceDefault = Pick<DraftSessionState, "envMode" | "startFromOrigin">;

interface PendingWorkspaceDefault {
  readonly projectRef: ScopedProjectRef;
  readonly workspace: DraftWorkspaceDefault;
  readonly openedManual: boolean;
  readonly settled: Promise<void>;
}

const pendingDefaults = new Map<DraftId, PendingWorkspaceDefault>();

function acceptsWorkspaceDefault(
  draft: DraftSessionState | null,
  pending: PendingWorkspaceDefault,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    draft.environmentId === pending.projectRef.environmentId &&
    draft.projectId === pending.projectRef.projectId &&
    draft.envMode === pending.workspace.envMode &&
    !draft.workspaceExplicit &&
    draft.worktreePath === null &&
    (pending.openedManual || draft.environmentSelection !== "manual")
  );
}

/** The workspace snapshot a checkout or a detached send is allowed to update/use. */
function workspaceKey(draft: DraftSessionState | null): string | null {
  if (draft === null || draft.promotedTo != null) return null;
  return JSON.stringify([
    draft.environmentId,
    draft.projectId,
    draft.threadId,
    draft.branch,
    draft.worktreePath,
    draft.envMode,
    draft.startFromOrigin,
    draft.workspaceExplicit,
    draft.environmentSelection,
    draft.selectedProjectIds,
    draft.worktreeRepositories,
    draft.checkoutPullRequest,
  ]);
}

export function readDraftWorkspaceKey(draftId: DraftId): string | null {
  return workspaceKey(useComposerDraftStore.getState().getDraftSession(draftId));
}

type DraftCheckoutOutcome =
  | { readonly status: "ready"; readonly workspace: string }
  | { readonly status: "failed" | "stale" };

interface PendingDraftCheckout {
  readonly outcome: Promise<DraftCheckoutOutcome>;
  readonly stopWatching: () => void;
}

const pendingCheckouts = new Map<DraftId, PendingDraftCheckout>();

export function readPendingDraftCheckout(draftId: DraftId) {
  return pendingCheckouts.get(draftId)?.outcome ?? null;
}

export function readPreparedDraftCheckout(draftId: DraftId, workspace: string) {
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return workspaceKey(draft) === workspace ? draft : null;
}

/** Only the current checkout can re-point a draft, and only while its workspace is unchanged. */
export function trackPendingDraftCheckout<T>(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  checkout: Promise<T>,
  apply: (value: T) => boolean,
  isCancelled: () => boolean,
): Promise<{ readonly value: T; readonly applied: boolean }> {
  const get = () => useComposerDraftStore.getState().getDraftSession(draftId);
  const initial = get();
  const initialWorkspace = workspaceKey(initial);
  let changed =
    initialWorkspace === null ||
    initial?.environmentId !== projectRef.environmentId ||
    initial?.projectId !== projectRef.projectId ||
    (initial?.selectedProjectIds?.length ?? 0) >= 2;
  const stopWatching = useComposerDraftStore.subscribe(() => {
    changed ||= workspaceKey(get()) !== initialWorkspace;
  });
  pendingCheckouts.get(draftId)?.stopWatching();
  const canApply = (): boolean =>
    !isCancelled() &&
    !changed &&
    pendingCheckouts.get(draftId) === pending &&
    workspaceKey(get()) === initialWorkspace;
  const prepared = checkout.then((value) => {
    const current = canApply();
    stopWatching();
    const applied = current && applyPendingDraftWorkspaceUpdate(draftId, () => apply(value));
    const workspace = applied ? workspaceKey(get()) : null;
    const outcome: DraftCheckoutOutcome =
      workspace !== null
        ? { status: "ready", workspace }
        : { status: current ? "failed" : "stale" };
    return { value, applied: workspace !== null, outcome };
  });
  const outcome = prepared
    .then(
      ({ outcome }) => outcome,
      (): DraftCheckoutOutcome => ({ status: "failed" }),
    )
    .finally(() => {
      stopWatching();
      if (pendingCheckouts.get(draftId) === pending) pendingCheckouts.delete(draftId);
    });
  const pending: PendingDraftCheckout = { outcome, stopWatching };
  pendingCheckouts.set(draftId, pending);
  return prepared;
}

export function readPendingWorkspaceDefault(draftId: DraftId): Promise<boolean> | null {
  const checkout = readPendingDraftCheckout(draftId);
  if (checkout) return checkout.then((outcome) => outcome.status === "ready");
  const pending = pendingDefaults.get(draftId);
  if (!pending) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return acceptsWorkspaceDefault(draft, pending) ? pending.settled.then(() => true) : null;
}

/** A visible draft can use a provisional workspace while its project file loads. */
export function trackPendingWorkspaceDefault(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  workspace: DraftWorkspaceDefault,
  resolution: Promise<DraftWorkspaceDefault>,
) {
  const { getDraftSession, setDraftThreadContext } = useComposerDraftStore.getState();
  const settled = resolution
    .then((resolved) => {
      const draft = getDraftSession(draftId);
      if (pendingDefaults.get(draftId) !== pending || !acceptsWorkspaceDefault(draft, pending))
        return;
      if (
        resolved.envMode === workspace.envMode &&
        resolved.startFromOrigin === workspace.startFromOrigin
      )
        return;
      // A send waiting on this promise must see the resolved workspace when it resumes.
      flushSync(() =>
        applyPendingDraftWorkspaceUpdate(draftId, () =>
          setDraftThreadContext(draftId, {
            envMode: resolved.envMode,
            ...(draft.startFromOrigin === workspace.startFromOrigin
              ? { startFromOrigin: resolved.startFromOrigin }
              : {}),
          }),
        ),
      );
    })
    .finally(() => {
      if (pendingDefaults.get(draftId) === pending) pendingDefaults.delete(draftId);
    });
  const pending = {
    projectRef,
    workspace,
    openedManual: getDraftSession(draftId)?.environmentSelection === "manual",
    settled,
  };
  pendingDefaults.set(draftId, pending);
}
