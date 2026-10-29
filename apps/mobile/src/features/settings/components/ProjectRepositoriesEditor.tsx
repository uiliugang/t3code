import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../../state/server";
import {
  AuthOrchestrationOperateScope,
  WorkspaceRootId,
  type ProjectWorkspaceRoot,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { View } from "react-native";
import { AppText, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { uuidv4 } from "../../../lib/uuid";
import { projectEnvironment } from "../../../state/projects";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useEnvironmentScope } from "../../../state/session";
import { SettingsSection } from "./SettingsSection";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";

export function ProjectRepositoriesEditor({ project }: { project: EnvironmentProject }) {
  const { selectedProjectKey, getSelectedProjectKey, selectProject } =
    useSettingsEnvironmentFilter();
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const permission = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const allowed = permission && config?.environment.capabilities.multiRepositoryWorkspaces === true;
  const update = useAtomCommand(projectEnvironment.update, { reportFailure: true });
  const [roots, setRoots] = useState<ReadonlyArray<ProjectWorkspaceRoot>>(
    () =>
      project.workspaceConfig?.roots ?? [
        {
          id: WorkspaceRootId.make(uuidv4()),
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
  const [primary, setPrimary] = useState(project.workspaceConfig?.primaryRootId ?? roots[0]!.id);
  const [version, setVersion] = useState(project.workspaceConfig?.version ?? 0);
  const [saving, setSaving] = useState(false);
  const change = (id: WorkspaceRootId, patch: Partial<ProjectWorkspaceRoot>) =>
    setRoots((current) => current.map((root) => (root.id === id ? { ...root, ...patch } : root)));
  const valid =
    roots.every((root) => root.alias.trim() && root.sourcePath.trim()) &&
    new Set(roots.map((root) => root.alias.trim())).size === roots.length;
  const save = async () => {
    if (!allowed || saving || !valid) return;
    setSaving(true);
    try {
      const result = await update({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          workspaceRoot: roots.find((root) => root.id === primary)!.sourcePath,
          workspaceConfig: { primaryRootId: primary, roots },
          expectedWorkspaceVersion: version,
        },
      });
      if (result._tag === "Success") {
        setVersion(result.value.workspaceConfig?.version ?? version);
        if (getSelectedProjectKey() === selectedProjectKey)
          selectProject(
            derivePhysicalProjectKey({ ...result.value, environmentId: project.environmentId }),
          );
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection title="Repositories">
      <View className="gap-4 p-4">
        <AppText className="text-sm text-foreground-muted">
          New tasks use these repositories. Existing tasks keep their bound workspace.
        </AppText>
        {roots.map((root) => (
          <View key={root.id} className="gap-3 rounded-xl border border-border p-3">
            <Button
              label={primary === root.id ? "Primary repository" : "Make primary"}
              disabled={!allowed || saving || primary === root.id}
              onPress={() => setPrimary(root.id)}
            />
            <AppText>Repository name</AppText>
            <AppTextInput
              accessibilityLabel="Repository name"
              editable={allowed && !saving}
              value={root.alias}
              onChangeText={(alias) => change(root.id, { alias })}
            />
            <AppText>Directory on this environment</AppText>
            <AppTextInput
              accessibilityLabel="Repository directory"
              autoCapitalize="none"
              autoCorrect={false}
              editable={allowed && !saving}
              value={root.sourcePath}
              onChangeText={(sourcePath) => change(root.id, { sourcePath })}
            />
            <AppText>Repository context</AppText>
            <AppTextInput
              accessibilityLabel="Repository context"
              editable={allowed && !saving}
              value={root.description}
              onChangeText={(description) => change(root.id, { description })}
            />
            <AppText>Default base ref</AppText>
            <AppTextInput
              accessibilityLabel="Default base ref"
              autoCapitalize="none"
              editable={allowed && !saving}
              placeholder="HEAD"
              value={root.defaultBaseRef ?? ""}
              onChangeText={(value) => {
                const { defaultBaseRef: _base, ...rest } = root;
                setRoots((current) =>
                  current.map((entry) =>
                    entry.id === root.id
                      ? { ...rest, ...(value.trim() ? { defaultBaseRef: value } : {}) }
                      : entry,
                  ),
                );
              }}
            />
            <AppText>Worktree setup command</AppText>
            <AppTextInput
              accessibilityLabel="Worktree setup command"
              autoCapitalize="none"
              autoCorrect={false}
              editable={allowed && !saving}
              value={root.setupScript?.command ?? ""}
              onChangeText={(value) => {
                const { setupScript: _setup, ...rest } = root;
                setRoots((current) =>
                  current.map((entry) =>
                    entry.id === root.id
                      ? {
                          ...rest,
                          ...(value.trim()
                            ? {
                                setupScript: {
                                  id: `setup-${root.id}`,
                                  name: "Setup",
                                  command: value,
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
              }}
            />
            <Button
              label="Remove repository"
              tone="danger"
              disabled={!allowed || saving || roots.length === 1 || primary === root.id}
              onPress={() => setRoots((current) => current.filter((entry) => entry.id !== root.id))}
            />
          </View>
        ))}
        <Button
          label="Add repository"
          disabled={!allowed || saving || roots.length >= 16}
          onPress={() =>
            setRoots((current) => [
              ...current,
              {
                id: WorkspaceRootId.make(uuidv4()),
                alias: "",
                sourcePath: "",
                description: "",
                accessIntent: "write",
                defaultSelected: true,
              },
            ])
          }
        />
        <Button
          label="Save repositories"
          tone="primary"
          loading={saving}
          disabled={!allowed || !valid}
          onPress={() => void save()}
        />
      </View>
    </SettingsSection>
  );
}
