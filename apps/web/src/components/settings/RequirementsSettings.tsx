import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, IssueProvider, ProjectId } from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { IssueSelect } from "../requirements/IssueSelect";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";
import { SourceControlSettingsPanel } from "./SourceControlSettings";

function ProjectIssueSources({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.issueProjectSources);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [provider, setProvider] = useState<IssueProvider>("meituan");
  const [scope, setScope] = useState("");
  const [host, setHost] = useState("github.com");
  const [busy, setBusy] = useState(false);
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const selected = projectId ?? projects[0]?.id;
  const save = async () => {
    if (!selected || !scope.trim()) return;
    setBusy(true);
    const entries = [
      ...(saved[selected] ?? []).filter((source) => source.provider !== provider),
      {
        provider,
        scope: scope.trim(),
        host: provider === "meituan" ? "mep.sankuai.com" : host.trim(),
      },
    ];
    const result = await update({
      environmentId,
      input: { patch: { issueProjectSources: { [selected]: entries } } },
    });
    setBusy(false);
    if (result._tag === "Success") setScope("");
  };
  const remove = async (id: ProjectId, kind: IssueProvider) => {
    setBusy(true);
    await update({
      environmentId,
      input: {
        patch: {
          issueProjectSources: {
            [id]: (saved[id] ?? []).filter((source) => source.provider !== kind),
          },
        },
      },
    });
    setBusy(false);
  };
  const valid =
    provider === "meituan"
      ? /^[1-9]\d*$/u.test(scope)
      : /^[\w.-]+\/[\w.-]+$/u.test(scope) && /^[\w.-]+$/u.test(host);
  return (
    <SettingsSection id="issue-project-sources" title="Project issue sources">
      <div className="space-y-5 p-4">
        <div className="divide-y divide-border">
          {projects.flatMap((project) =>
            (saved[project.id] ?? []).map((source) => (
              <div
                key={`${project.id}/${source.provider}`}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{project.title}</p>
                  <p className="text-xs text-muted-foreground wrap-anywhere">
                    {source.provider === "meituan" ? "MEP ONES" : "GitHub Issues"} · {source.scope}
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("Remove issue source")}
                        disabled={!allowed || busy}
                        onClick={() => void remove(project.id, source.provider)}
                      />
                    }
                  >
                    <Trash2Icon />
                  </TooltipTrigger>
                  <TooltipPopup>{t("Remove issue source")}</TooltipPopup>
                </Tooltip>
              </div>
            )),
          )}
        </div>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1.5">
            <Label>{t("Project")}</Label>
            <IssueSelect
              label={t("Project")}
              value={selected ?? ""}
              options={projects.map((project) => ({ value: project.id, label: project.title }))}
              onChange={(value) => setProjectId(value as ProjectId)}
              disabled={!allowed || busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("Issue source")}</Label>
            <IssueSelect
              label={t("Issue source")}
              value={provider}
              options={[
                { value: "meituan", label: "MEP ONES" },
                { value: "github", label: "GitHub Issues" },
              ]}
              onChange={(value) => {
                setProvider(value === "github" ? "github" : "meituan");
                setScope("");
              }}
              disabled={!allowed || busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-source-scope">
              {t(provider === "meituan" ? "MEP space ID" : "GitHub repository")}
            </Label>
            <Input
              id="issue-source-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              placeholder={provider === "meituan" ? "1031008" : "owner/repository"}
              disabled={!allowed || busy}
            />
          </div>
          {provider === "github" ? (
            <div className="space-y-1.5">
              <Label htmlFor="issue-source-host">{t("GitHub host")}</Label>
              <Input
                id="issue-source-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                disabled={!allowed || busy}
              />
            </div>
          ) : null}
          <div className="flex justify-end sm:col-span-2">
            <Button size="sm" type="submit" disabled={!allowed || busy || !selected || !valid}>
              <PlusIcon />
              {t("Save issue source")}
            </Button>
          </div>
        </form>
      </div>
    </SettingsSection>
  );
}

export function RequirementsSettings() {
  const t = useUiTranslation();
  const { environment } = useSettingsScope();
  return (
    <SourceControlSettingsPanel integrationsOnly>
      {environment ? (
        <ProjectIssueSources
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("Choose an environment to configure issue sources.")}
        </p>
      )}
    </SourceControlSettingsPanel>
  );
}
