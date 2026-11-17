import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, IssueProvider, ProjectId } from "@t3tools/contracts";
import { PlusIcon, ScanSearchIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
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
  return (
    <>
      {(["meituan", "github"] as const)
        .filter((provider) => provider !== "meituan" || meituanEnabled)
        .map((provider) => (
          <MenuItem
            key={provider}
            disabled={!canCreateIssue || !projects.length}
            onClick={() => createIssue(environmentId, provider)}
          >
            {provider === "github" ? "GitHub Issue" : "MEP ONES"}
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

export function RequirementScanMenu({
  environments,
  projectId,
  refreshed,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  projectId?: ProjectId;
  refreshed: () => void;
}) {
  const t = useUiTranslation();
  const discover = useAtomCommand(serverEnvironment.discoverWorkItems);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const scan = async (environmentId: EnvironmentId, projectId: ProjectId) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    await discover({ environmentId, input: { projectId } }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
    refreshed();
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            disabled={!environments.length || busy}
            aria-label={`${t("Scan chats")} ${t("Select a project")}`}
          >
            <ScanSearchIcon />
            <span className="hidden sm:inline">{t("Scan chats")}</span>
          </Button>
        }
      />
      <MenuPopup align="start">
        {environments.map((environment) => (
          <EnvironmentScanItems
            key={environment.environmentId}
            environment={environment}
            projectId={projectId}
            scan={scan}
            busy={busy}
          />
        ))}
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentScanItems({
  environment,
  projectId,
  scan,
  busy,
}: {
  environment: EnvironmentPresentation;
  projectId: ProjectId | undefined;
  scan: (environmentId: EnvironmentId, projectId: ProjectId) => Promise<void>;
  busy: boolean;
}) {
  const { environmentId } = environment;
  const t = useUiTranslation();
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      !project.isScratch &&
      project.archivedAt === null &&
      (!projectId || project.id === projectId),
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const permitted = useAtomValue(serverEnvironment.discoverWorkItems.permissionAtom(environmentId));
  return (
    <MenuSub>
      <MenuSubTrigger
        disabled={!permitted || config?.workItemDiscovery !== true || !projects.length || busy}
      >
        {environment.label}
      </MenuSubTrigger>
      <MenuSubPopup>
        {projects.map((project) => (
          <MenuItem
            key={project.id}
            disabled={busy}
            onClick={() => void scan(environmentId, project.id)}
          >
            {project.title}
          </MenuItem>
        ))}
        <MenuItem disabled>
          {t("Suggestions do not start agents or change existing tasks.")}
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}
