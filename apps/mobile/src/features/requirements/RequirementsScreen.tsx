import { StackActions, useNavigation } from "@react-navigation/native";
import type { StaticScreenProps } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  IssueError,
  BranchIssueError,
  type IssueProvider,
  type IssueMetadataInput,
} from "@t3tools/contracts";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { Linking, View, Pressable } from "react-native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { IssuePicker } from "./IssuePicker";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { serverEnvironment } from "../../state/server";
import { RequirementDeliveryPanel } from "./RequirementDeliveryPanel";
import { ProjectTag, Disclosure, useRequirementGroups } from "./RequirementPrimitives";
import { DraftFillButton } from "./DraftFillButton";
import { Menu } from "../../components/ui/Menu";
import { IconButton } from "../../components/ui/IconButton";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  DELIVERY_PROGRESS_LABELS,
  REQUIREMENT_GROUPS,
  requirementGroup,
} from "@t3tools/client-runtime/work-item";

type Target = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  provider: IssueProvider;
  scope?: string;
};
const isBranchIssueError = Schema.is(BranchIssueError);
const isIssueError = Schema.is(IssueError);

export function RequirementsScreen() {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const [selectedEnvironment, setEnvironment] = useState<EnvironmentId | null>(null);
  const environmentId = selectedEnvironment ?? environments[0]?.environmentId ?? null;
  const allProjects = useProjects();
  const projects = allProjects.filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const [provider, setProvider] = useState<IssueProvider>("meituan");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [assignee, setAssignee] = useState("me");
  const [queryText, setQueryText] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const { collapsed, toggle } = useRequirementGroups();
  const result = useEnvironmentQuery(
    environmentId
      ? sourceControlEnvironment.issues({
          environmentId,
          input: { provider, assignee, query, page, ...(projectId ? { projectId } : {}) },
        })
      : null,
  );
  const peopleProject = projectId ?? result.data?.groups[0]?.projectIds[0];
  const people = useEnvironmentQuery(
    environmentId && peopleProject
      ? sourceControlEnvironment.issuePeople({
          environmentId,
          input: {
            projectId: peopleProject,
            provider,
            query: "",
            scope: result.data?.groups.find((group) => group.projectIds.includes(peopleProject))
              ?.source.scope,
          },
        })
      : null,
  );
  const assigneeOptions = [
    ...new Map(
      [
        ...(people.data ?? []),
        ...(result.data?.groups.flatMap((group) =>
          group.issues.flatMap((issue) => issue.assignees),
        ) ?? []),
      ].map((person) => [person.value, person]),
    ).values(),
  ];
  const allowed = useAtomValue(sourceControlEnvironment.createIssue.permissionAtom(environmentId));
  const entries =
    result.data?.groups.flatMap((group) =>
      group.issues.map((issue) => ({
        issue,
        projectId: group.projectIds[0],
        scope: group.source.scope,
      })),
    ) ?? [];
  const tracked = useAtomValue(
    serverEnvironment.issueWorkItems(
      environmentId,
      entries.map(({ issue }) => issue.url),
    ),
  );
  return (
    <SettingsScreen title={t("Requirements board")}>
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-5 pb-12">
        <View className="flex-row items-center gap-1">
          <View className="min-w-0 flex-1">
            <AppTextInput
              accessibilityLabel={t("Search title or number")}
              placeholder={t("Search title or number")}
              value={queryText}
              onChangeText={setQueryText}
              onSubmitEditing={() => {
                setQuery(queryText);
                setPage(1);
              }}
              returnKeyType="search"
            />
          </View>
          <Menu
            title={t("Filters")}
            actions={[
              {
                id: "environment",
                title: t("Environment"),
                subactions: environments.map((env) => ({
                  id: "env:" + env.environmentId,
                  title: env.label,
                  state: env.environmentId === environmentId ? ("on" as const) : ("off" as const),
                })),
              },
              {
                id: "source",
                title: t("Issue source"),
                subactions: [
                  {
                    id: "source:meituan",
                    title: "MEP ONES",
                    state: provider === "meituan" ? "on" : "off",
                  },
                  {
                    id: "source:github",
                    title: "GitHub Issues",
                    state: provider === "github" ? "on" : "off",
                  },
                  { id: "source:local", title: t("Local work items") },
                ],
              },
              {
                id: "project",
                title: t("Project"),
                subactions: [
                  {
                    id: "project:",
                    title: t("All projects"),
                    state: projectId === null ? ("on" as const) : ("off" as const),
                  },
                  ...projects.map((project) => ({
                    id: "project:" + project.id,
                    title: project.title,
                    state: project.id === projectId ? ("on" as const) : ("off" as const),
                  })),
                ],
              },
              {
                id: "assignee",
                title: t("Assignee"),
                subactions: [
                  { value: "me", label: t("Assigned to me") },
                  { value: "all", label: t("All assignees") },
                  { value: "unassigned", label: t("Unassigned") },
                  ...assigneeOptions.filter(
                    (person) => !["me", "all", "unassigned"].includes(person.value),
                  ),
                ].map((person) => ({
                  id: "assignee:" + person.value,
                  title: person.label,
                  state: person.value === assignee ? ("on" as const) : ("off" as const),
                })),
              },
              { id: "refresh", title: t("Refresh issues") },
              { id: "settings", title: t("Issue management") },
            ]}
            onPressAction={(event) => {
              const id = event.nativeEvent.event;
              if (id.startsWith("env:")) {
                setEnvironment(EnvironmentId.make(id.slice(4)));
                setProjectId(null);
              }
              if (id.startsWith("project:"))
                setProjectId(id.slice(8) ? ProjectId.make(id.slice(8)) : null);
              if (id.startsWith("assignee:")) setAssignee(id.slice(9));
              if (id === "source:local")
                navigation.navigate("WorkItems", {
                  ...(environmentId ? { environmentId } : {}),
                  ...(projectId ? { projectId } : {}),
                });
              if (id === "source:github" || id === "source:meituan")
                setProvider(id === "source:github" ? "github" : "meituan");
              if (id === "refresh") result.refresh();
              if (id === "settings") navigation.navigate("SettingsRequirements");
              setPage(1);
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Filters")}
              className="size-12 items-center justify-center"
            >
              <SymbolView
                name="line.3.horizontal.decrease"
                size={22}
                tintColorClassName="accent-foreground"
              />
            </Pressable>
          </Menu>
          <IconButton
            icon="plus"
            accessibilityLabel={t("New issue")}
            disabled={!allowed || !environmentId || !projects.length}
            onPress={() => {
              const project = projects.find((entry) => entry.id === projectId) ?? projects[0];
              if (environmentId && project)
                navigation.navigate("IssueCreate", {
                  environmentId,
                  projectId: project.id,
                  provider,
                });
            }}
          />
        </View>
        <Text className="text-xs text-foreground-muted">
          {provider === "github" ? "GitHub Issues" : "MEP ONES"} ·{" "}
          {projects.find((project) => project.id === projectId)?.title ?? t("All projects")} ·{" "}
          {assigneeOptions.find((person) => person.value === assignee)?.label ??
            t(
              assignee === "me"
                ? "Assigned to me"
                : assignee === "all"
                  ? "All assignees"
                  : "Unassigned",
            )}
        </Text>
        {result.error ? <Text className="text-danger">{result.error}</Text> : null}
        {result.data?.failures.map((failure) => (
          <Text key={failure.projectId} className="text-danger">
            {t(failure.reason)}
          </Text>
        ))}
        {result.isPending ? <Text>{t("Loading...")}</Text> : null}
        {REQUIREMENT_GROUPS.map((group) => {
          const rows = entries.filter(
            ({ issue }) =>
              requirementGroup(issue.stateCategory, tracked.get(issue.url)?.deliverySummary) ===
              group.key,
          );
          if (!rows.length) return null;
          return (
            <Disclosure
              key={group.key}
              title={t(group.label)}
              count={rows.length}
              open={!collapsed.includes(group.key)}
              onToggle={() => toggle(group.key)}
            >
              {rows.map(({ issue, projectId: itemProject, scope }) => {
                const summary = tracked.get(issue.url)?.deliverySummary;
                return (
                  <Pressable
                    key={issue.url}
                    accessibilityRole="button"
                    onPress={() => {
                      if (environmentId && itemProject)
                        navigation.navigate("IssueDetail", {
                          environmentId,
                          projectId: itemProject,
                          provider,
                          id: issue.id,
                          scope,
                        });
                    }}
                    className="gap-2 border-b border-border-subtle py-3"
                  >
                    <View className="flex-row items-start gap-3">
                      <Text className="min-w-0 flex-1 text-base font-t3-medium">{issue.title}</Text>
                      {issue.priority ? (
                        <Text className="text-xs text-foreground-muted">{issue.priority}</Text>
                      ) : null}
                    </View>
                    <View className="flex-row flex-wrap items-center gap-2">
                      <ProjectTag
                        title={
                          projects.find((project) => project.id === itemProject)?.title ??
                          itemProject ??
                          t("Project")
                        }
                      />
                      <Text className="text-xs text-foreground-muted">#{issue.id}</Text>
                      <Text className="text-xs text-foreground-muted">
                        {issue.assignees.map((person) => person.label).join(", ") ||
                          t("Unassigned")}
                      </Text>
                    </View>
                    <View className="flex-row flex-wrap items-center gap-3">
                      {summary && summary.requiredPullRequests > 0 ? (
                        <Text className="text-xs text-foreground-muted">
                          PR {summary.mergedPullRequests}/{summary.requiredPullRequests}
                        </Text>
                      ) : null}
                      <Text
                        className={
                          group.key === "attention"
                            ? "text-xs text-danger"
                            : "text-xs text-foreground-muted"
                        }
                      >
                        {summary
                          ? t(
                              summary.synced && summary.progress === "delivery_complete"
                                ? "Completed"
                                : DELIVERY_PROGRESS_LABELS[summary.progress],
                            )
                          : issue.state}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </Disclosure>
          );
        })}
        {!result.isPending && !result.data?.groups.some((group) => group.issues.length) ? (
          <Text className="text-foreground-muted">{t("No matching issues.")}</Text>
        ) : null}
        <View className="flex-row flex-wrap gap-3">
          <Button
            label={t("Previous")}
            disabled={page === 1 || result.isPending}
            onPress={() => setPage(page - 1)}
          />
          <Button
            label={t("Next")}
            disabled={!result.data?.groups.some((group) => group.hasMore) || result.isPending}
            onPress={() => setPage(page + 1)}
          />
          <Button label={t("Refresh issues")} icon="arrow.clockwise" onPress={result.refresh} />
        </View>
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function IssueDetailScreen({ route }: StaticScreenProps<Target & { id: string }>) {
  const t = useUiTranslation();
  const target = route.params;
  const { environmentId } = target;
  const result = useEnvironmentQuery(
    sourceControlEnvironment.issueDetail({ environmentId, input: target }),
  );
  const tracking = useEnvironmentQuery(
    result.data
      ? serverEnvironment.workItemsLive({ environmentId, input: { issueUrl: result.data.url } })
      : null,
  );
  const command = useAtomCommand(sourceControlEnvironment.setIssueState);
  const canWrite = useAtomValue(
    sourceControlEnvironment.setIssueState.permissionAtom(environmentId),
  );
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);
  const styles = useMarkdownPreviewStyles();
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === target.projectId,
  );
  const branches = useEnvironmentQuery(
    project && result.data
      ? sourceControlEnvironment.issueBranches({
          environmentId,
          input: { cwd: project.workspaceRoot, url: result.data.url },
        })
      : null,
  );
  const link = useAtomCommand(sourceControlEnvironment.updateBranchIssues);
  const canLink = useAtomValue(
    sourceControlEnvironment.updateBranchIssues.permissionAtom(environmentId),
  );
  const [branch, setBranch] = useState("");
  const update = async () => {
    if (!state) return;
    setBusy(true);
    await command({ environmentId, input: { ...target, state } });
    setBusy(false);
    result.refresh();
  };
  const associate = async (name: string, action: "associate" | "disassociate") => {
    if (!project || !result.data) return;
    setBusy(true);
    await link({
      environmentId,
      input: { cwd: project.workspaceRoot, branch: name, action, urls: [result.data.url] },
    });
    setBusy(false);
    branches.refresh();
  };
  return (
    <SettingsScreen title={t("Issue details")}>
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-5 px-5 pb-12">
        {result.error ? <Text className="text-danger">{result.error}</Text> : null}
        {result.data ? (
          <>
            <View className="gap-3">
              <ProjectTag title={project?.title ?? target.projectId} />
              <Text className="text-xl font-t3-semibold">{result.data.title}</Text>
              <Text className="text-xs text-foreground-muted">
                #{target.id} · {result.data.state} ·{" "}
                {result.data.assignees.map((person) => person.label).join(", ") || t("Unassigned")}
              </Text>
            </View>
            {tracking.data?.item ? (
              <RequirementDeliveryPanel
                environmentId={environmentId}
                item={tracking.data.item}
                summary={tracking.data.items[0]?.deliverySummary}
                transitions={result.data.transitions}
              />
            ) : null}
            <Disclosure title={t("Change status")}>
              <IssuePicker
                label={t("Change status")}
                value={state}
                options={result.data.transitions}
                onChange={setState}
                disabled={!canWrite || busy}
              />
              <Button
                label={t("Update")}
                disabled={!canWrite || busy || !state}
                onPress={() => void update()}
              />
            </Disclosure>
            <Disclosure title={t("Description")}>
              <SelectableMarkdownText
                markdown={result.data.body || t("No description.")}
                textStyle={styles.nativeTextStyle}
                onLinkPress={(url) => {
                  if (/^https?:\/\//u.test(url)) void Linking.openURL(url);
                }}
              />
            </Disclosure>
            <Disclosure title={t("Linked branches")}>
              <Text className="text-xs text-foreground-muted">
                {t(target.provider === "meituan" ? "Synced with MEP" : "Only in this environment")}
              </Text>
              {branches.error ? (
                <Text className="text-danger">
                  {isBranchIssueError(branches.failure) &&
                  branches.failure.reason === "invalid-link"
                    ? t("Branch links require a repository on the same platform as the issue.")
                    : branches.error}
                </Text>
              ) : null}
              {branches.data
                ?.filter((entry) => entry.linked)
                .map((entry) => (
                  <View key={entry.name} className="gap-2">
                    <Text>{entry.name}</Text>
                    <Button
                      label={t("Unlink issue")}
                      disabled={!canLink || busy}
                      onPress={() => void associate(entry.name, "disassociate")}
                    />
                  </View>
                ))}
              <IssuePicker
                label={t("Choose branch")}
                value={branch}
                options={(branches.data ?? [])
                  .filter((entry) => !entry.linked)
                  .map((entry) => ({ value: entry.name, label: entry.name }))}
                onChange={setBranch}
                disabled={!canLink || busy}
              />
              <Button
                label={t("Link branch")}
                disabled={!canLink || busy || !branch}
                onPress={() => void associate(branch, "associate")}
              />
            </Disclosure>
            <Button
              label={t("View original")}
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(result.data!.url)}
            />
          </>
        ) : (
          <Text>{t("Loading...")}</Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function IssueCreateScreen({ route }: StaticScreenProps<Target>) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const [selectedScope, setSelectedScope] = useState("");
  const projects = useProjects().filter(
    (project) => project.environmentId === route.params.environmentId && !project.isScratch,
  );
  const [projectId, setProjectId] = useState(route.params.projectId);
  const [selectedProvider, setProvider] = useState<IssueProvider | null>(null);
  const sources = useEnvironmentQuery(
    sourceControlEnvironment.issueSources({
      environmentId: route.params.environmentId,
      input: { projectIds: [projectId] },
    }),
  );
  const availableProviders = [
    ...new Set(sources.data?.[0]?.sources.map((source) => source.provider) ?? []),
  ];
  const platformSelected =
    availableProviders.length === 1 ||
    (selectedProvider !== null && availableProviders.includes(selectedProvider));
  const provider =
    availableProviders.length === 1
      ? availableProviders[0]!
      : (selectedProvider ?? route.params.provider);
  const scopes =
    sources.data?.[0]?.sources
      .filter((source) => source.provider === provider)
      .map((source) => source.scope) ?? [];
  const scope = scopes.includes(selectedScope) ? selectedScope : scopes[0];
  const target = { ...route.params, projectId, provider, ...(scope ? { scope } : {}) };
  const [type, setType] = useState<(typeof IssueMetadataInput.Type)["type"]>("REQUIREMENT");
  const [subtype, setSubtype] = useState("");
  const [title, setTitle] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const allowed = useAtomValue(
    sourceControlEnvironment.createIssue.permissionAtom(target.environmentId),
  );
  const command = useAtomCommand(sourceControlEnvironment.createIssue, { reportFailure: false });
  const metadata = useEnvironmentQuery(
    scope && platformSelected
      ? sourceControlEnvironment.issueMetadata({
          environmentId: target.environmentId,
          input: { ...target, type, subtype, query: personQuery },
        })
      : null,
  );
  const people = useEnvironmentQuery(
    scope && platformSelected
      ? sourceControlEnvironment.issuePeople({
          environmentId: target.environmentId,
          input: { ...target, query: personQuery },
        })
      : null,
  );
  const submit = async () => {
    if (!scope || generating || !platformSelected) return;
    setBusy(true);
    setError(null);
    const result = await command({
      environmentId: target.environmentId,
      input: {
        ...target,
        title,
        body,
        type,
        subtype,
        assignees: assignee ? [assignee] : [],
        fields,
      },
    });
    setBusy(false);
    if (result._tag === "Success")
      navigation.dispatch(StackActions.replace("IssueDetail", { ...target, id: result.value.id }));
    else {
      const failure = squashAtomCommandFailure(result);
      setError(
        isIssueError(failure)
          ? [t(failure.message), ...(failure.fields ?? []).map((field) => field.message)].join("\n")
          : failure instanceof Error
            ? t(failure.message)
            : t("Could not create issue."),
      );
      if (
        failure &&
        typeof failure === "object" &&
        "reason" in failure &&
        failure.reason === "outcome-unknown"
      )
        setUncertain(true);
    }
  };
  return (
    <SettingsScreen title={t("New issue")}>
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-5 pb-12">
        <IssuePicker
          label={t("Project")}
          value={projectId}
          options={projects.map((project) => ({ value: project.id, label: project.title }))}
          disabled={busy || generating}
          onChange={(value) => {
            setProjectId(ProjectId.make(value));
            setProvider(null);
            setAssignee("");
            setPersonQuery("");
            setSelectedScope("");
            setSubtype("");
            setFields({});
          }}
        />
        {availableProviders.length > 1 ? (
          <IssuePicker
            label={t("Choose platform")}
            value={selectedProvider ?? ""}
            options={availableProviders.map((value) => ({
              value,
              label: value === "github" ? "GitHub Issues" : "MEP ONES",
            }))}
            disabled={busy || generating}
            onChange={(value) => {
              setProvider(value === "github" ? "github" : "meituan");
              setAssignee("");
              setPersonQuery("");
              setSelectedScope("");
              setSubtype("");
              setFields({});
            }}
          />
        ) : null}
        <DraftFillButton
          environmentId={target.environmentId}
          projectId={target.projectId}
          context={[title, body].filter(Boolean).join("\n\n")}
          disabled={busy || uncertain}
          onBusyChange={setGenerating}
          onDraft={(draft) => {
            setTitle(draft.title);
            setBody(
              [
                draft.description,
                draft.constraints.length
                  ? t("Constraints") +
                    "\n" +
                    draft.constraints.map((line) => "- " + line).join("\n")
                  : "",
                draft.acceptanceCriteria.length
                  ? t("Acceptance criteria") +
                    "\n" +
                    draft.acceptanceCriteria.map((line) => "- " + line).join("\n")
                  : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            );
          }}
        />
        {scopes.length > 1 ? (
          <IssuePicker
            label={t("MEP space ID")}
            value={scope ?? ""}
            options={scopes.map((value) => ({ value, label: value }))}
            onChange={(value) => {
              setSelectedScope(value);
              setAssignee("");
              setPersonQuery("");
              setSubtype("");
              setFields({});
            }}
          />
        ) : null}
        {target.provider === "meituan" ? (
          <>
            <IssuePicker
              label={t("Work item type")}
              value={type}
              options={[
                { value: "REQUIREMENT", label: t("Requirement") },
                { value: "DEVTASK", label: t("Task") },
                { value: "DEFECT", label: t("Defect") },
              ]}
              onChange={(value) => {
                setType(value as typeof type);
                setSubtype("");
                setFields({});
              }}
            />
            <IssuePicker
              label={t("Subtype")}
              value={subtype}
              options={metadata.data?.subtypes ?? []}
              onChange={(value) => {
                setSubtype(value);
                setFields({});
              }}
            />
          </>
        ) : null}
        <AppTextInput
          accessibilityLabel={t("Title")}
          placeholder={t("Title")}
          value={title}
          onChangeText={setTitle}
          editable={!busy && !generating}
          maxLength={256}
        />
        <AppTextInput
          accessibilityLabel={t("Description")}
          placeholder={t("Description")}
          multiline
          value={body}
          onChangeText={setBody}
          editable={!busy && !generating}
        />
        <AppTextInput
          accessibilityLabel={t("Search people")}
          placeholder={t("Search people")}
          onSubmitEditing={(event) => setPersonQuery(event.nativeEvent.text)}
          returnKeyType="search"
          editable={!busy && !generating}
        />
        <IssuePicker
          label={t("Assignee")}
          value={assignee}
          options={[{ value: "", label: t("Unassigned") }, ...(people.data ?? [])]}
          onChange={setAssignee}
          disabled={busy || generating}
        />
        {metadata.data?.fields.map((field) => (
          <View key={field.variable} className="gap-2">
            <Text>
              {field.label}
              {field.required ? " *" : ""}
            </Text>
            {field.options.length && field.multiple ? (
              field.options.map((option) => (
                <ListToggleRow
                  key={option.value}
                  label={option.label}
                  disabled={busy || generating}
                  value={(fields[field.variable] ?? "").split(",").includes(option.value)}
                  onValueChange={(checked) => {
                    const selected = (fields[field.variable] ?? "")
                      .split(",")
                      .filter(Boolean)
                      .filter((value) => value !== option.value);
                    setFields({
                      ...fields,
                      [field.variable]: [...selected, ...(checked ? [option.value] : [])].join(","),
                    });
                  }}
                />
              ))
            ) : field.options.length ? (
              <IssuePicker
                label={field.label}
                value={fields[field.variable] ?? ""}
                options={field.options}
                onChange={(value) => setFields({ ...fields, [field.variable]: value })}
                disabled={busy || generating}
              />
            ) : (
              <AppTextInput
                accessibilityLabel={field.label}
                value={fields[field.variable] ?? ""}
                onChangeText={(value) => setFields({ ...fields, [field.variable]: value })}
                editable={!busy && !generating}
              />
            )}
          </View>
        ))}
        {error || metadata.error ? (
          <Text className="text-danger">{error ?? metadata.error}</Text>
        ) : null}
        <Button
          label={t("Create issue")}
          icon="plus"
          loading={busy}
          disabled={
            generating ||
            !platformSelected ||
            !allowed ||
            !title.trim() ||
            uncertain ||
            metadata.isPending ||
            Boolean(metadata.error) ||
            metadata.data?.fields.some(
              (field) => field.required && !fields[field.variable]?.trim(),
            ) ||
            (target.provider === "meituan" && !subtype)
          }
          onPress={() => void submit()}
        />
      </ScreenScrollView>
    </SettingsScreen>
  );
}
