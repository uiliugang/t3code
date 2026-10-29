import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  WorkspaceRootId,
  type EnvironmentId,
  type ProjectWorkspaceRoot,
} from "@t3tools/contracts";
import { LayersIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { create } from "zustand";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useUiTranslation } from "../hooks/useUiTranslation";
import { newProjectId, randomUUID } from "../lib/utils";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentsWithScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { workspaceCreateInput, workspaceCreationError } from "./createWorkspace";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Radio, RadioGroup } from "./ui/radio-group";
import { stackedThreadToast, toastManager } from "./ui/toast";

const useRequest = create<{ open: boolean; session: number }>(() => ({ open: false, session: 0 }));

export function openCreateWorkspace() {
  if (useRequest.getState().open) return;
  useRequest.setState((state) => ({ open: true, session: state.session + 1 }));
}

function close() {
  useRequest.setState({ open: false });
}

export function CreateWorkspaceDialogHost() {
  const { open, session } = useRequest();
  return open ? <CreateWorkspaceDialog key={session} /> : null;
}

function CreateWorkspaceDialog() {
  const t = useUiTranslation();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const available = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.multiRepositoryWorkspaces === true &&
      permitted.has(environment.environmentId),
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    () =>
      available.find((environment) => environment.environmentId === primaryEnvironmentId)
        ?.environmentId ??
      available[0]?.environmentId ??
      null,
  );
  const [busy, setBusy] = useState(false);
  const selectedId = environmentId;
  const allowed = available.some((environment) => environment.environmentId === selectedId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <LayersIcon className="size-5" />
              {t("Create group")}
            </span>
          </DialogTitle>
          <DialogDescription>
            {t(
              "Bring existing repositories together for one task. Each repository gets its own worktree when the task starts.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="mb-4 space-y-2">
            <Label>{t("Environment")}</Label>
            <Select
              value={selectedId}
              disabled={busy}
              onValueChange={(value) => {
                if (value) setEnvironmentId(value);
              }}
            >
              <SelectTrigger aria-label={t("Environment")}>
                <SelectValue>
                  {(value: EnvironmentId | null) =>
                    environments.find((environment) => environment.environmentId === value)
                      ?.label ?? t("Select environment")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((environment) => (
                  <SelectItem
                    key={environment.environmentId}
                    value={environment.environmentId}
                    disabled={
                      !available.some((entry) => entry.environmentId === environment.environmentId)
                    }
                  >
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {!allowed ? (
            <p role="alert" className="mb-4 text-sm text-muted-foreground">
              {t("Connect to an environment with group support and project editing permission.")}
            </p>
          ) : null}
          {selectedId ? (
            <WorkspaceForm
              key={selectedId}
              environmentId={selectedId}
              allowed={allowed}
              busy={busy}
              setBusy={setBusy}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function emptyRoot(): ProjectWorkspaceRoot {
  return {
    id: WorkspaceRootId.make(randomUUID()),
    alias: "",
    sourcePath: "",
    description: "",
    defaultSelected: true,
    accessIntent: "write",
  };
}

function WorkspaceForm({
  environmentId,
  allowed,
  busy,
  setBusy,
}: {
  environmentId: EnvironmentId;
  allowed: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const t = useUiTranslation();
  const id = useId();
  const projects = useProjects();
  const repositories = [
    ...new Map(
      projects
        .filter((project) => project.environmentId === environmentId)
        .flatMap(
          (project) =>
            project.workspaceConfig?.roots.map(
              (root) =>
                [
                  root.sourcePath,
                  { name: root.alias, path: root.sourcePath, description: root.description },
                ] as const,
            ) ?? [
              [
                project.workspaceRoot,
                { name: project.title, path: project.workspaceRoot, description: "" },
              ] as const,
            ],
        ),
    ).values(),
  ];
  const createProject = useOrchestrationCommand(projectEnvironment.create);
  const handleNewThread = useNewThreadHandler();
  const [projectId] = useState(newProjectId);
  const [title, setTitle] = useState("");
  const [roots, setRoots] = useState(() => [emptyRoot()]);
  const [primaryRootId, setPrimaryRootId] = useState(roots[0]!.id);
  const [error, setError] = useState<string | null>(null);
  const validation = workspaceCreationError({ title, roots, primaryRootId });
  const change = (rootId: WorkspaceRootId, patch: Partial<ProjectWorkspaceRoot>) => {
    setRoots((current) =>
      current.map((root) => (root.id === rootId ? { ...root, ...patch } : root)),
    );
    setError(null);
  };
  const submit = async () => {
    if (!allowed || busy) return;
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await createProject({
      environmentId,
      input: workspaceCreateInput({ projectId, title, roots, primaryRootId }),
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : t("Could not create group."));
      return;
    }
    close();
    const navigation = await settlePromise(() =>
      handleNewThread(scopeProjectRef(environmentId, projectId), { envMode: "worktree" }),
    );
    if (navigation._tag === "Failure")
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Group created. Open it from the project list to continue."),
        }),
      );
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-name`}>{t("Group name")}</Label>
          <Input
            id={`${id}-name`}
            value={title}
            maxLength={200}
            onChange={(event) => {
              setTitle(event.target.value);
              setError(null);
            }}
            placeholder={t("e.g. Customer portal")}
            autoFocus
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {t("Choose repositories from this environment or enter their existing directories.")}
        </p>
        <RadioGroup
          value={primaryRootId}
          onValueChange={(value) => setPrimaryRootId(WorkspaceRootId.make(String(value)))}
          aria-label={t("Primary repository")}
        >
          {roots.map((root, index) => (
            <div key={root.id} className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <Label>
                  <Radio value={root.id} />
                  {t("Primary repository")}
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("Remove repository {number}", { number: index + 1 })}
                  disabled={roots.length <= 1}
                  onClick={() => {
                    const next = roots.filter((entry) => entry.id !== root.id);
                    setRoots(next);
                    if (primaryRootId === root.id) setPrimaryRootId(next[0]!.id);
                    setError(null);
                  }}
                >
                  <Trash2Icon />
                </Button>
              </div>
              {repositories.length > 0 ? (
                <Select
                  value={
                    repositories.some((repository) => repository.path === root.sourcePath)
                      ? root.sourcePath
                      : null
                  }
                  onValueChange={(value) => {
                    const selected = repositories.find((repository) => repository.path === value);
                    if (selected)
                      change(root.id, {
                        alias: selected.name,
                        sourcePath: selected.path,
                        description: selected.description,
                      });
                  }}
                >
                  <SelectTrigger
                    aria-label={t("Choose repository {number}", { number: index + 1 })}
                  >
                    <SelectValue placeholder={t("Choose an existing repository")}>
                      {(value: string | null) =>
                        repositories.find((repository) => repository.path === value)?.name ??
                        t("Choose an existing repository")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {repositories.map((repository) => (
                      <SelectItem
                        key={repository.path}
                        value={repository.path}
                        disabled={roots.some(
                          (entry) => entry.id !== root.id && entry.sourcePath === repository.path,
                        )}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span>{repository.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {repository.path}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`${root.id}-alias`}>{t("Repository name")}</Label>
                  <Input
                    id={`${root.id}-alias`}
                    maxLength={128}
                    value={root.alias}
                    onChange={(event) => change(root.id, { alias: event.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${root.id}-path`}>{t("Directory on this environment")}</Label>
                  <Input
                    id={`${root.id}-path`}
                    value={root.sourcePath}
                    onChange={(event) => change(root.id, { sourcePath: event.target.value })}
                    placeholder="/path/to/repository"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${root.id}-context`}>{t("Repository context")}</Label>
                <Input
                  id={`${root.id}-context`}
                  maxLength={2000}
                  value={root.description}
                  onChange={(event) => change(root.id, { description: event.target.value })}
                  placeholder={t("Frontend, backend API, shared schemas...")}
                />
              </div>
            </div>
          ))}
        </RadioGroup>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={roots.length >= 16}
          onClick={() => setRoots((current) => [...current, emptyRoot()])}
        >
          <PlusIcon />
          {t("Add repository")}
        </Button>
      </fieldset>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {t(error)}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={!allowed || busy}>
          {busy ? t("Creating...") : t("Create group")}
        </Button>
      </DialogFooter>
    </form>
  );
}
