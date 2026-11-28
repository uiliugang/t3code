import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, IssueProvider, ProjectId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import {
  trackerCreateTargetKey,
  trackerCreateTargetLabel,
  trackerCreateTargets,
  type TrackerCreateTarget,
} from "@t3tools/client-runtime/work-item";
import { Button } from "../ui/button";
import { isMeituanServiceEnabled } from "@t3tools/contracts";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "../ui/menu";

type CreateActions = {
  createTrackerIssue: (environmentId: EnvironmentId, target: TrackerCreateTarget) => void;
  createIssue: (environmentId: EnvironmentId, provider: IssueProvider) => void;
  createLocal: (environmentId: EnvironmentId, projectId: ProjectId) => void;
};

export function RequirementCreateMenu({
  environments,
  projectId,
  ...actions
}: CreateActions & {
  environments: ReadonlyArray<EnvironmentPresentation>;
  projectId?: ProjectId;
}) {
  const t = useUiTranslation();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" disabled={!environments.length}>
            <PlusIcon />
            {t("New")}
          </Button>
        }
      />
      <MenuPopup align="end">
        {environments.map((environment) =>
          environments.length === 1 ? (
            <EnvironmentCreateItems
              key={environment.environmentId}
              environmentId={environment.environmentId}
              projectId={projectId}
              {...actions}
            />
          ) : (
            <MenuSub key={environment.environmentId}>
              <MenuSubTrigger>{environment.label}</MenuSubTrigger>
              <MenuSubPopup>
                <EnvironmentCreateItems
                  environmentId={environment.environmentId}
                  projectId={projectId}
                  {...actions}
                />
              </MenuSubPopup>
            </MenuSub>
          ),
        )}
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentCreateItems({
  environmentId,
  projectId,
  createIssue,
  createTrackerIssue,
  createLocal,
}: CreateActions & {
  environmentId: EnvironmentId;
  projectId: ProjectId | undefined;
}) {
  const t = useUiTranslation();
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      !project.isScratch &&
      project.archivedAt === null &&
      (!projectId || project.id === projectId),
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const trackers = useEnvironmentQuery(
    config?.requirementIssueTrackers
      ? issueEnvironment.list({
          environmentId,
          input: { state: "all", limit: 1, ...(projectId ? { projectId } : {}) },
        })
      : null,
  );
  const canCreateTracker = useAtomValue(issueEnvironment.create.permissionAtom(environmentId));
  const meituanEnabled = isMeituanServiceEnabled(
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)),
    "requirements",
  );
  const canCreateLocal = useAtomValue(
    serverEnvironment.mutateWorkItem.permissionAtom(environmentId),
  );
  const canCreateIssue = useAtomValue(
    sourceControlEnvironment.createIssue.permissionAtom(environmentId),
  );
  const createTargets = trackerCreateTargets(trackers.data);
  return (
    <>
      {createTargets.map((target) => (
        <MenuItem
          key={trackerCreateTargetKey(target)}
          disabled={!canCreateTracker}
          onClick={() => createTrackerIssue(environmentId, target)}
        >
          {trackerCreateTargetLabel(target, createTargets, projects)}
        </MenuItem>
      ))}
      {(["meituan", "github"] as const)
        .filter((provider) => provider !== "meituan" || meituanEnabled)
        .map((provider) => (
          <MenuItem
            key={provider}
            disabled={!canCreateIssue || !projects.length}
            onClick={() => createIssue(environmentId, provider)}
          >
            {provider === "github" ? t("GitHub Issue") : t("MEP ONES")}
          </MenuItem>
        ))}
      <MenuSub>
        <MenuSubTrigger
          disabled={!canCreateLocal || config?.workItems !== true || !projects.length}
        >
          {t("Local work item")}
        </MenuSubTrigger>
        <MenuSubPopup>
          {projects.map((project) => (
            <MenuItem key={project.id} onClick={() => createLocal(environmentId, project.id)}>
              {project.title}
            </MenuItem>
          ))}
        </MenuSubPopup>
      </MenuSub>
    </>
  );
}
