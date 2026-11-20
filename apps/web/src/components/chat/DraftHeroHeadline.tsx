import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import {
  AuthOrchestrationOperateScope,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { CheckIcon, FolderPlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import { useClientSettings } from "~/hooks/useSettings";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { seedDraftModelSelection } from "~/lib/seedDraftModelSelection";
import {
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentsWithScope } from "~/state/session";
import { resolveDraftProjectSelection } from "../createWorkspace";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import { ProjectLabel } from "../ProjectLabel";
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button, InlineButton } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { DraftProjectName } from "./DraftProjectName";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { TriageDraftHero } from "./TriageDraftHero";

const ADD_PROJECT_VALUE = "add-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const t = useUiTranslation();
  const [beforeProject = "", afterProject = ""] = t("{project} to start").split("{project}");
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const permittedEnvironments = useEnvironmentsWithScope(
    environments,
    AuthOrchestrationOperateScope,
  );
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const draftSession = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : null,
  );
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const openAddProject = () => openCommandPalette({ open: "add-project" });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pendingSelection, setPendingSelection] = useState<{
    environmentId: EnvironmentId;
    projectIds: readonly ProjectId[];
  } | null>(null);
  const [pendingGroupTitle, setPendingGroupTitle] = useState<string | null>(null);
  const pickerFilter = useComboboxFilter();
  const highlightedPickerValueRef = useRef<string | null>(null);
  const suppressNextChangeRef = useRef(false);
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const multiRepoEnvironmentIds = new Set<EnvironmentId>(
    environments
      .filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          environment.serverConfig?.environment.capabilities.multiRepositoryWorkspaces === true &&
          permittedEnvironments.has(environment.environmentId),
      )
      .map((environment) => environment.environmentId),
  );
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const isAdhocGroupDraft = (draftSession?.selectedProjectIds?.length ?? 0) >= 2;
  const effectiveProjectTitle =
    (isAdhocGroupDraft ? draftSession?.groupTitle : undefined) ?? activeProjectTitle;
  const hasResolvedProject = effectiveProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(activeProjectRef?.environmentId ?? null);
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));

  const selectedProjectIdsForDraft: readonly ProjectId[] =
    pendingSelection?.projectIds ??
    (isAdhocGroupDraft
      ? (draftSession?.selectedProjectIds ?? [])
      : activeProject && !isScratchDraft
        ? [activeProject.id]
        : []);
  const selectedEnvironmentId: EnvironmentId | null =
    pendingSelection?.environmentId ??
    (isAdhocGroupDraft
      ? (draftSession?.environmentId ?? activeProject?.environmentId ?? null)
      : activeProject && !isScratchDraft
        ? activeProject.environmentId
        : null);

  const resolveMemberForEnvironment = (
    entry: (typeof menuEntries)[number],
    preferredEnvironmentId: EnvironmentId | null,
  ) =>
    (preferredEnvironmentId
      ? entry.group.memberProjects.find((member) => member.environmentId === preferredEnvironmentId)
      : undefined) ?? entry.targetProject;

  const isEntrySelected = (entry: (typeof menuEntries)[number]): boolean => {
    if (selectedEnvironmentId === null || selectedProjectIdsForDraft.length === 0) return false;
    return entry.group.memberProjects.some(
      (member) =>
        member.environmentId === selectedEnvironmentId &&
        selectedProjectIdsForDraft.includes(member.id),
    );
  };

  const canCombineEntry = (entry: (typeof menuEntries)[number]): boolean => {
    if (selectedEnvironmentId !== null && selectedProjectIdsForDraft.length > 0) {
      if (!multiRepoEnvironmentIds.has(selectedEnvironmentId)) return false;
      return entry.group.memberProjects.some(
        (member) => member.environmentId === selectedEnvironmentId,
      );
    }
    return entry.group.memberProjects.some((member) =>
      multiRepoEnvironmentIds.has(member.environmentId),
    );
  };

  // Pinning from a row keeps rows in place while the picker is open.
  const pickerItems: readonly PickerItem[] = useOrderWhileOpen(
    [
      ...menuEntries.map(({ group }) => ({ value: group.projectKey, label: group.displayName })),
      { value: ADD_PROJECT_VALUE, label: t("Add project") },
    ],
    (item) => item.value,
    pickerOpen,
  );
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = isAdhocGroupDraft
    ? null
    : (pickerItems.find((item) => item.value === activeProjectKey) ?? null);

  const pendingScratchRef = useRef<symbol | null>(null);
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };
  // Retargeting an empty draft would overwrite the project's draft and strand browser tabs.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    pendingScratchRef.current = null;
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    if (!composerDraftHasUserContent(getComposerDraft(draftId))) {
      void openProjectDraft(projectRef);
      return;
    }
    setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
      selectedProjectIds: null,
      groupTitle: null,
    });
    seedDraftModelSelection(draftId, projectRef);
  };

  const applySelectedProjects = (nextProjects: readonly (typeof projects)[number][]) => {
    if (!draftId || nextProjects.length === 0) return;
    pendingScratchRef.current = null;
    const targetEnvironmentId = nextProjects[0]!.environmentId;
    const envProjects = projects.filter(
      (candidate) => candidate.environmentId === targetEnvironmentId,
    );
    const resolved = resolveDraftProjectSelection(nextProjects, envProjects);
    if (!resolved) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: t("Choose up to 16 repositories from one environment."),
        }),
      );
      return;
    }
    if (resolved.kind === "single" || resolved.kind === "existing-group") {
      const logicalKey = deriveLogicalProjectKeyFromSettings(
        resolved.project,
        projectGroupingSettings,
      );
      if (!composerDraftHasUserContent(getComposerDraft(draftId))) {
        void openProjectDraft(
          resolved.projectRef,
          resolved.kind === "existing-group" ? { envMode: "worktree" } : undefined,
        );
        return;
      }
      setLogicalProjectDraftThreadId(logicalKey, resolved.projectRef, draftId, {
        ...(resolved.kind === "existing-group" ? { envMode: "worktree" } : {}),
        selectedProjectIds: null,
        groupTitle: null,
      });
      seedDraftModelSelection(draftId, resolved.projectRef);
      return;
    }
    if (!composerDraftHasUserContent(getComposerDraft(draftId))) {
      void openProjectDraft(resolved.primaryProjectRef, {
        logicalProjectKey: resolved.logicalProjectKey,
        envMode: "worktree",
        selectedProjectIds: resolved.selectedProjectIds,
        groupTitle: pendingGroupTitle?.trim() || draftSession?.groupTitle?.trim() || resolved.title,
      });
      return;
    }
    setLogicalProjectDraftThreadId(
      resolved.logicalProjectKey,
      resolved.primaryProjectRef,
      draftId,
      {
        envMode: "worktree",
        selectedProjectIds: resolved.selectedProjectIds,
        groupTitle: pendingGroupTitle?.trim() || draftSession?.groupTitle?.trim() || resolved.title,
      },
    );
    seedDraftModelSelection(draftId, resolved.primaryProjectRef);
  };

  const stageSelectedProjects = (nextProjects: readonly (typeof projects)[number][]) => {
    if (nextProjects.length === 0) return;
    if (!resolveDraftProjectSelection(nextProjects, projects)) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: t("Choose up to 16 repositories from one environment."),
        }),
      );
      return;
    }
    setPendingSelection({
      environmentId: nextProjects[0]!.environmentId,
      projectIds: nextProjects.map((project) => project.id),
    });
    setPendingGroupTitle((title) => title ?? draftSession?.groupTitle ?? null);
  };

  const toggleProjectEntry = (entry: (typeof menuEntries)[number]) => {
    const member = resolveMemberForEnvironment(entry, selectedEnvironmentId);
    const targetEnvId = selectedEnvironmentId ?? member.environmentId;
    if (!multiRepoEnvironmentIds.has(targetEnvId)) return;
    if (member.environmentId !== targetEnvId) return;

    const envProjectsById = new Map(
      projects
        .filter((candidate) => candidate.environmentId === targetEnvId)
        .map((candidate) => [candidate.id, candidate] as const),
    );
    const currentSelected = selectedProjectIdsForDraft.flatMap((id) => {
      const found = envProjectsById.get(id);
      return found ? [found] : [];
    });
    const alreadySelected = currentSelected.some((candidate) => candidate.id === member.id);
    if (alreadySelected) {
      if (currentSelected.length <= 1) return;
      stageSelectedProjects(currentSelected.filter((candidate) => candidate.id !== member.id));
      return;
    }
    stageSelectedProjects([...currentSelected, member]);
  };

  const makePrimaryProject = (projectId: ProjectId) => {
    if (!selectedEnvironmentId || selectedProjectIdsForDraft.length < 2) return;
    const envProjectsById = new Map(
      projects
        .filter((candidate) => candidate.environmentId === selectedEnvironmentId)
        .map((candidate) => [candidate.id, candidate] as const),
    );
    const currentSelected = selectedProjectIdsForDraft.flatMap((id) => {
      const found = envProjectsById.get(id);
      return found ? [found] : [];
    });
    const nextPrimary = currentSelected.find((candidate) => candidate.id === projectId);
    if (!nextPrimary || currentSelected[0]?.id === projectId) return;
    stageSelectedProjects([
      nextPrimary,
      ...currentSelected.filter((candidate) => candidate.id !== projectId),
    ]);
  };

  const selectedProjectsResolved =
    selectedEnvironmentId === null
      ? []
      : selectedProjectIdsForDraft.flatMap((id) => {
          const found = projects.find(
            (candidate) => candidate.environmentId === selectedEnvironmentId && candidate.id === id,
          );
          return found ? [found] : [];
        });
  const pendingResolved = pendingSelection
    ? resolveDraftProjectSelection(selectedProjectsResolved, projects)
    : null;
  const groupTitle =
    pendingGroupTitle ??
    (pendingResolved?.kind === "adhoc-group"
      ? pendingResolved.title
      : pendingResolved?.project.title) ??
    draftSession?.groupTitle ??
    "";

  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const request = Symbol("scratch");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const project = await openScratchProject(scratchTargetEnvironmentId);
    if (!project || pendingScratchRef.current !== request || draftTargetKey() !== requestedTarget) {
      return false;
    }
    pendingScratchRef.current = null;
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onItemHighlighted={(item) => {
        highlightedPickerValueRef.current = item?.value ?? null;
      }}
      onOpenChange={(open, eventDetails) => {
        if (eventDetails.isCanceled) return;
        if (open) suppressNextChangeRef.current = false;
        setPickerOpen(open);
        setPickerQuery("");
        if (!open) {
          setPendingSelection(null);
          setPendingGroupTitle(null);
        }
      }}
      value={selectedPickerItem}
      onValueChange={(item, eventDetails) => {
        if (suppressNextChangeRef.current) {
          suppressNextChangeRef.current = false;
          return;
        }
        if (!item) return;
        if (item.value === ADD_PROJECT_VALUE) {
          setPickerOpen(false);
          openAddProject();
          return;
        }
        const entry = projectEntryByKey.get(item.value);
        if (!entry) return;
        const isToggleEvent =
          eventDetails.event instanceof MouseEvent &&
          (eventDetails.event.shiftKey || eventDetails.event.metaKey || eventDetails.event.ctrlKey);
        if (isToggleEvent && canCombineEntry(entry)) {
          eventDetails.cancel();
          toggleProjectEntry(entry);
          return;
        }
        setPickerOpen(false);
        if (!isAdhocGroupDraft && item.value === activeProjectKey) {
          return;
        }
        selectProject(entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={<InlineButton tone="picker" />}
              data-draft-project-trigger=""
              className="pointer-events-auto min-w-0 max-w-full align-baseline"
            />
          }
        >
          <ProjectLabel
            name={
              isScratchDraft ? t("No project") : (effectiveProjectTitle ?? t("Choose a project"))
            }
            project={isScratchDraft ? undefined : (activeProjectGroup ?? undefined)}
            {...(isAdhocGroupDraft ? { kindOverride: "group" as const } : {})}
          />
        </TooltipTrigger>
        {effectiveProjectTitle && !isScratchDraft ? (
          <TooltipPopup side="top">{effectiveProjectTitle}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="center" className="w-80 overflow-hidden">
        <ComboboxSearchInput
          aria-label={t("Search projects")}
          placeholder={t("Search projects...")}
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }
            const highlighted = highlightedPickerValueRef.current;
            const entry = highlighted ? projectEntryByKey.get(highlighted) : undefined;
            const group = entry?.group;
            if (group && canPinProjectGroup(group) && isProjectPinShortcut(event, keybindings)) {
              event.preventDefault();
              event.stopPropagation();
              toggleProjectGroupPin(group);
              return;
            }
            if (
              entry &&
              canCombineEntry(entry) &&
              event.shiftKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              event.key === "Enter"
            ) {
              event.preventDefault();
              event.stopPropagation();
              toggleProjectEntry(entry);
            }
          }}
        />
        <ComboboxEmpty>{t("No matching projects.")}</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            const selected = entry ? isEntrySelected(entry) : false;
            const combinable = entry ? canCombineEntry(entry) : false;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                selectedFill={!isAdhocGroupDraft}
                value={item}
              >
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <span className="relative flex shrink-0">
                    <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                    {selectedProjectIdsForDraft.length > 1 && selected ? (
                      <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-popover">
                        <CheckIcon
                          className="size-2 text-primary-foreground"
                          strokeWidth={4}
                          aria-hidden
                        />
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                    <ProjectLabel name={item.label} project={entry?.group} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{item.label}</TooltipPopup>
                </Tooltip>
                {entry && canPinProjectGroup(entry.group) ? (
                  <ProjectPinButton
                    name={entry.group.displayName}
                    pinned={entry.group.pinned}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                    onToggle={() => toggleProjectGroupPin(entry.group)}
                  />
                ) : null}
                {entry && multiRepoEnvironmentIds.size > 0 ? (
                  <span className="flex shrink-0">
                    <Checkbox
                      checked={selected}
                      tabIndex={-1}
                      aria-label={
                        selected
                          ? t("Remove {name} from group", { name: entry.group.displayName })
                          : t("Combine with {name}", { name: entry.group.displayName })
                      }
                      disabled={!combinable || (selected && selectedProjectIdsForDraft.length <= 1)}
                      onPointerDown={(event) => event.stopPropagation()}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        suppressNextChangeRef.current = true;
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        suppressNextChangeRef.current = false;
                      }}
                      onCheckedChange={() => toggleProjectEntry(entry)}
                    />
                  </span>
                ) : null}
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
        {(pendingSelection || isAdhocGroupDraft) && draftId ? (
          <div className="space-y-2 border-t border-border/70 px-3 py-2.5">
            <Label>{t("Primary repository")}</Label>
            <div className="max-h-32 overflow-y-auto">
              <RadioGroup
                aria-label={t("Primary repository")}
                value={selectedProjectIdsForDraft[0] ?? ""}
                onValueChange={(value) => {
                  const project = selectedProjectsResolved.find((entry) => entry.id === value);
                  if (project) makePrimaryProject(project.id);
                }}
              >
                {selectedProjectsResolved.map((project) => (
                  <Label key={project.id}>
                    <Radio value={project.id} />
                    <span className="truncate">{project.title}</span>
                  </Label>
                ))}
              </RadioGroup>
            </div>
            {selectedProjectIdsForDraft.length > 1 ? (
              <Input
                size="sm"
                aria-label={t("Group name")}
                placeholder={t("Group name")}
                value={groupTitle}
                maxLength={200}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applySelectedProjects(selectedProjectsResolved);
                    setPickerOpen(false);
                  }
                }}
                onChange={(event) => {
                  setPendingGroupTitle(event.target.value);
                }}
              />
            ) : null}
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => {
                  if (pendingSelection || pendingGroupTitle !== null)
                    applySelectedProjects(selectedProjectsResolved);
                  setPendingSelection(null);
                  setPendingGroupTitle(null);
                  setPickerOpen(false);
                }}
              >
                {t("Done")}
              </Button>
            </div>
          </div>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline min-w-0 max-w-full cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <DraftProjectName value={effectiveProjectTitle ?? t("Add a project")} singleLine />
    </button>
  );

  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          {t("or start without a project")}
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      {hasResolvedProject && !isScratchDraft ? (
        <DraftHeroProjectHeading projectName={effectiveProjectTitle ?? t("Choose a project")}>
          {projectSelector}
        </DraftHeroProjectHeading>
      ) : (
        <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          {isScratchDraft ? (
            t("What should we work on?")
          ) : canChooseProject ? (
            <>
              {beforeProject}
              {projectSelector}
              {afterProject}
            </>
          ) : (
            t("Add a project to start")
          )}
        </h1>
      )}
      {scratchWorkspaceRoot === null ? null : (
        <p className="mt-2 flex h-6 w-full items-center justify-center text-sm">
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
}
