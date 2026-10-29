import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import {
  AuthOrchestrationOperateScope,
  WorkspaceRootId,
  type ProjectWorkspaceRoot,
} from "@t3tools/contracts";
import { useState } from "react";
import type { Project } from "../../types";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { projectEnvironment } from "../../state/projects";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

export function ProjectRepositoriesSettings({ project }: { project: Project }) {
  const t = useUiTranslation();
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const permission = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const allowed = permission && config?.environment.capabilities.multiRepositoryWorkspaces === true;
  const update = useOrchestrationCommand(projectEnvironment.update, { reportFailure: true });
  const [roots, setRoots] = useState<ReadonlyArray<ProjectWorkspaceRoot>>(
    () =>
      project.workspaceConfig?.roots ?? [
        {
          id: WorkspaceRootId.make(randomUUID()),
          alias: project.title,
          sourcePath: project.workspaceRoot,
          description: "",
          accessIntent: "write",
          defaultSelected: true,
          ...(project.scripts.find((script) => script.runOnWorktreeCreate)
            ? { setupScript: project.scripts.find((script) => script.runOnWorktreeCreate)! }
            : {}),
        },
      ],
  );
  const [primaryRootId, setPrimaryRootId] = useState(
    project.workspaceConfig?.primaryRootId ?? roots[0]!.id,
  );
  const [editingVersion, setEditingVersion] = useState(project.workspaceConfig?.version ?? 0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const change = (id: WorkspaceRootId, patch: Partial<ProjectWorkspaceRoot>) => {
    setSaved(false);
    setRoots((current) => current.map((root) => (root.id === id ? { ...root, ...patch } : root)));
  };
  const valid =
    roots.every((root) => root.alias.trim() && root.sourcePath.trim()) &&
    new Set(roots.map((root) => root.alias.trim())).size === roots.length;
  const save = async () => {
    if (!allowed || saving || !valid) return;
    setSaving(true);
    try {
      const primary = roots.find((root) => root.id === primaryRootId)!;
      const result = await update({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          workspaceRoot: primary.sourcePath,
          workspaceConfig: { primaryRootId, roots },
          expectedWorkspaceVersion: editingVersion,
        },
      });
      setSaved(result._tag === "Success");
      if (result._tag === "Success") setEditingVersion((version) => version + 1);
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection title="Repositories">
      <div className="flex flex-col gap-4 px-3 py-3 sm:px-4">
        <p className="text-sm text-muted-foreground">
          {t("New tasks use these repositories. Existing tasks keep their bound group.")}
        </p>
        {roots.map((root) => (
          <fieldset
            key={root.id}
            disabled={!allowed || saving}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
          >
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name={`primary-repository-${project.id}`}
                  checked={root.id === primaryRootId}
                  onChange={() => {
                    setPrimaryRootId(root.id);
                    change(root.id, { defaultSelected: true });
                  }}
                />
                {t("Primary repository")}
              </label>
              <div className="ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={roots.length === 1 || root.id === primaryRootId}
                  onClick={() => {
                    setRoots((current) => current.filter((entry) => entry.id !== root.id));
                    setSaved(false);
                  }}
                >
                  {t("Remove")}
                </Button>
              </div>
            </div>
            <label className="flex flex-col gap-1 text-xs">
              {t("Repository name")}
              <Input
                value={root.alias}
                onChange={(event) => change(root.id, { alias: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t("Directory on this environment")}
              <Input
                value={root.sourcePath}
                onChange={(event) => change(root.id, { sourcePath: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t("Repository context")}
              <Input
                value={root.description}
                placeholder={t("Frontend, backend API, shared schemas...")}
                onChange={(event) => change(root.id, { description: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t("Default base ref")}
              <Input
                value={root.defaultBaseRef ?? ""}
                placeholder="HEAD"
                onChange={(event) => {
                  const { defaultBaseRef: _base, ...rest } = root;
                  setRoots((current) =>
                    current.map((entry) =>
                      entry.id === root.id
                        ? {
                            ...rest,
                            ...(event.target.value.trim()
                              ? { defaultBaseRef: event.target.value }
                              : {}),
                          }
                        : entry,
                    ),
                  );
                  setSaved(false);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t("Worktree setup command")}
              <Input
                value={root.setupScript?.command ?? ""}
                onChange={(event) => {
                  const { setupScript: _script, ...rest } = root;
                  setRoots((current) =>
                    current.map((entry) =>
                      entry.id === root.id
                        ? {
                            ...rest,
                            ...(event.target.value.trim()
                              ? {
                                  setupScript: {
                                    id: `setup-${root.id}`,
                                    name: "Setup",
                                    command: event.target.value,
                                    icon: "configure" as const,
                                    runOnWorktreeCreate: true,
                                    async: false,
                                  },
                                }
                              : {}),
                          }
                        : entry,
                    ),
                  );
                  setSaved(false);
                }}
              />
            </label>
          </fieldset>
        ))}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!allowed || saving || roots.length >= 16}
            onClick={() => {
              setRoots((current) => [
                ...current,
                {
                  id: WorkspaceRootId.make(randomUUID()),
                  alias: "",
                  sourcePath: "",
                  description: "",
                  defaultSelected: true,
                  accessIntent: "write",
                },
              ]);
              setSaved(false);
            }}
          >
            {t("Add repository")}
          </Button>
          <Button size="sm" disabled={!allowed || saving || !valid} onClick={() => void save()}>
            {saving ? t("Saving...") : saved ? t("Saved") : t("Save repositories")}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
