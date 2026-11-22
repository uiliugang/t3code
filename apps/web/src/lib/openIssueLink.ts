import type {
  EnvironmentId,
  IssueTrackerConnectionList,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent } from "react";

import { readIssueListPreferences } from "../components/issue/issueListPreferences";
import {
  isRequirementTracker,
  patchRequirementsSearch,
  requirementSelection,
  requirementsSearchFromIssuesSearch,
  type RequirementSearchPatch,
} from "../components/requirements/requirementPanelSearch";
import {
  ISSUES_PANEL_REF,
  PULL_REQUESTS_PANEL_REF,
  REQUIREMENTS_PANEL_REF,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import { useProjects, useServerConfigs } from "../state/entities";

/**
 * Opens an issue link beside the thread, and says whether it did. Anything else — a host no
 * project here is on, a link that merely looks like one — is left alone for the caller to handle
 * as the ordinary link it is. Mirrors `useOpenChangeRequestLink`: a reader following a link the
 * agent wrote is reading the thread, and should still be reading it afterwards.
 */
export function useOpenIssueLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetEnvironmentId?: EnvironmentId,
  trackers?: IssueTrackerConnectionList,
) => boolean {
  const allProjects = useProjects();
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  return (event, targetUrl, targetEnvironmentId, trackers) => {
    if (event.metaKey || event.ctrlKey) return false;
    const resolvedPanelRef = panelRef ?? threadRef;
    // A list page's panel ref is a placeholder, not an environment; the link names its own.
    const environmentId = threadRef?.environmentId ?? targetEnvironmentId;
    if (resolvedPanelRef === undefined || environmentId === undefined) return false;
    if (serverConfigs.get(environmentId)?.environment.capabilities.issues !== true) return false;
    const target = resolveIssueLinkTarget({
      url: targetUrl,
      projects: allProjects.filter((project) => project.environmentId === environmentId),
      trackers,
    });
    if (target === null) return false;
    event.preventDefault();
    event.stopPropagation();
    const surface = {
      projectId: target.ref.projectId,
      tracker: target.ref.tracker,
      ...(target.ref.host === undefined ? {} : { host: target.ref.host }),
      scope: target.ref.scope,
      key: target.ref.key,
      url: targetUrl,
    };
    // List panels share the unified requirements panel, so an issue link becomes a peer tab
    // without leaving the workflow or tracker list the reader is currently using.
    if (resolvedPanelRef === REQUIREMENTS_PANEL_REF) {
      const panels = useRightPanelStore.getState();
      if (isRequirementTracker(target.ref.tracker)) {
        panels.openRequirementIssue(REQUIREMENTS_PANEL_REF, {
          environmentId,
          projectId: target.ref.projectId,
          provider: target.ref.tracker,
          ...(target.ref.host === undefined ? {} : { host: target.ref.host }),
          scope: target.ref.scope,
          issueId: target.ref.key,
        });
      } else {
        panels.openIssue(REQUIREMENTS_PANEL_REF, { ...surface, environmentId });
      }
      const selected = selectActiveRightPanelSurface(panels.byThreadKey, REQUIREMENTS_PANEL_REF);
      void navigate({
        to: "/requirements",
        search: (previous) =>
          patchRequirementsSearch(
            previous as RequirementSearchPatch,
            requirementSelection(selected),
          ),
      });
      return true;
    }
    if (resolvedPanelRef === PULL_REQUESTS_PANEL_REF || resolvedPanelRef === ISSUES_PANEL_REF) {
      const panels = useRightPanelStore.getState();
      if (isRequirementTracker(target.ref.tracker)) {
        panels.openRequirementIssue(REQUIREMENTS_PANEL_REF, {
          environmentId,
          projectId: target.ref.projectId,
          provider: target.ref.tracker,
          ...(target.ref.host === undefined ? {} : { host: target.ref.host }),
          scope: target.ref.scope,
          issueId: target.ref.key,
        });
      } else {
        panels.openIssue(REQUIREMENTS_PANEL_REF, { ...surface, environmentId });
      }
      void navigate({
        to: "/requirements",
        search: requirementsSearchFromIssuesSearch({
          ...readIssueListPreferences(),
          selectedEnvironmentId: environmentId,
          selectedProjectId: target.ref.projectId,
          ...(target.ref.host === undefined ? {} : { selectedHost: target.ref.host }),
          tracker: target.ref.tracker,
          scope: target.ref.scope,
          key: target.ref.key,
        }),
      });
      return true;
    }
    useRightPanelStore.getState().openIssue(resolvedPanelRef, {
      ...(resolvedPanelRef.environmentId === environmentId ? {} : { environmentId }),
      ...surface,
    });
    return true;
  };
}
