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
import { Linking, View } from "react-native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
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
  return (
    <SettingsScreen title={t("Requirements board")}>
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-5 pb-12">
        {environments.length > 1 ? (
          <IssuePicker
            label={t("Environment")}
            value={environmentId ?? ""}
            options={environments.map((environment) => ({
              value: environment.environmentId,
              label: environment.label,
            }))}
            onChange={(value) => {
              setEnvironment(EnvironmentId.make(value));
              setProjectId(null);
              setPage(1);
            }}
          />
        ) : null}
        <IssuePicker
          label={t("Issue source")}
          value={provider}
          options={[
            { value: "meituan", label: "MEP ONES" },
            { value: "github", label: "GitHub Issues" },
            { value: "local", label: t("Local work items") },
          ]}
          onChange={(value) => {
            if (value === "local") {
              navigation.navigate("WorkItems", {
                ...(environmentId ? { environmentId } : {}),
                ...(projectId ? { projectId } : {}),
              });
              return;
            }
            setProvider(value === "github" ? "github" : "meituan");
            setPage(1);
          }}
        />
        <IssuePicker
          label={t("Project")}
          value={projectId ?? "all"}
          options={[
            { value: "all", label: t("All projects") },
            ...projects.map((project) => ({ value: project.id, label: project.title })),
          ]}
          onChange={(value) => {
            setProjectId(value === "all" ? null : ProjectId.make(value));
            setPage(1);
          }}
        />
        <IssuePicker
          label={t("Assignee")}
          value={assignee}
          options={[
            { value: "me", label: t("Assigned to me") },
            { value: "all", label: t("All assignees") },
            { value: "unassigned", label: t("Unassigned") },
            ...assigneeOptions,
          ]}
          onChange={(value) => {
            setAssignee(value);
            setPage(1);
          }}
        />
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
        <View className="flex-row flex-wrap gap-3">
          <Button
            label={t("New issue")}
            icon="plus"
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
          <Button
            label={t("Issue management")}
            icon="gearshape"
            onPress={() => navigation.navigate("SettingsRequirements")}
          />
        </View>
        {result.error ? <Text className="text-danger">{result.error}</Text> : null}
        {result.data?.failures.map((failure) => (
          <Text key={failure.projectId} className="text-danger">
            {t(failure.reason)}
          </Text>
        ))}
        {result.isPending ? <Text>{t("Loading...")}</Text> : null}
        {result.data?.groups.flatMap((group) =>
          group.issues.map((issue) => (
            <ListRow
              key={`${group.source.scope}/${issue.id}`}
              label={issue.title}
              description={`#${issue.id} · ${issue.state} · ${issue.assignees.map((person) => person.label).join(", ") || t("Unassigned")}`}
              onPress={() => {
                const target = group.projectIds[0];
                if (environmentId && target)
                  navigation.navigate("IssueDetail", {
                    environmentId,
                    projectId: target,
                    provider,
                    id: issue.id,
                    scope: group.source.scope,
                  });
              }}
            />
          )),
        )}
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
            <Text className="text-xl font-t3-semibold">{result.data.title}</Text>
            {tracking.data?.item ? (
              <RequirementDeliveryPanel
                environmentId={environmentId}
                item={tracking.data.item}
                summary={tracking.data.items[0]?.deliverySummary}
                transitions={result.data.transitions}
              />
            ) : null}
            <Text className="text-foreground-muted">
              #{target.id} · {result.data.state}
            </Text>
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
            <SelectableMarkdownText
              markdown={result.data.body || t("No description.")}
              textStyle={styles.nativeTextStyle}
              onLinkPress={(url) => {
                if (/^https?:\/\//u.test(url)) void Linking.openURL(url);
              }}
            />
            <Text className="font-t3-medium">{t("Linked branches")}</Text>
            <Text className="text-xs text-foreground-muted">
              {t(target.provider === "meituan" ? "Synced with MEP" : "Only in this environment")}
            </Text>
            {branches.error ? (
              <Text className="text-danger">
                {isBranchIssueError(branches.failure) && branches.failure.reason === "invalid-link"
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
  const sources = useEnvironmentQuery(
    sourceControlEnvironment.issueSources({
      environmentId: route.params.environmentId,
      input: { projectIds: [route.params.projectId] },
    }),
  );
  const scopes =
    sources.data?.[0]?.sources
      .filter((source) => source.provider === route.params.provider)
      .map((source) => source.scope) ?? [];
  const scope = scopes.includes(selectedScope) ? selectedScope : scopes[0];
  const target = { ...route.params, ...(scope ? { scope } : {}) };
  const [type, setType] = useState<(typeof IssueMetadataInput.Type)["type"]>("REQUIREMENT");
  const [subtype, setSubtype] = useState("");
  const [title, setTitle] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const allowed = useAtomValue(
    sourceControlEnvironment.createIssue.permissionAtom(target.environmentId),
  );
  const command = useAtomCommand(sourceControlEnvironment.createIssue, { reportFailure: false });
  const metadata = useEnvironmentQuery(
    sourceControlEnvironment.issueMetadata({
      environmentId: target.environmentId,
      input: { ...target, type, subtype, query: personQuery },
    }),
  );
  const people = useEnvironmentQuery(
    sourceControlEnvironment.issuePeople({
      environmentId: target.environmentId,
      input: { ...target, query: personQuery },
    }),
  );
  const submit = async () => {
    if (!scope) return;
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
        {scopes.length > 1 ? (
          <IssuePicker
            label={t("MEP space ID")}
            value={scope ?? ""}
            options={scopes.map((value) => ({ value, label: value }))}
            onChange={(value) => {
              setSelectedScope(value);
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
          editable={!busy}
          maxLength={256}
        />
        <AppTextInput
          accessibilityLabel={t("Description")}
          placeholder={t("Description")}
          multiline
          value={body}
          onChangeText={setBody}
          editable={!busy}
        />
        <AppTextInput
          accessibilityLabel={t("Search people")}
          placeholder={t("Search people")}
          onSubmitEditing={(event) => setPersonQuery(event.nativeEvent.text)}
          returnKeyType="search"
          editable={!busy}
        />
        <IssuePicker
          label={t("Assignee")}
          value={assignee}
          options={[{ value: "", label: t("Unassigned") }, ...(people.data ?? [])]}
          onChange={setAssignee}
          disabled={busy}
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
                  disabled={busy}
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
                disabled={busy}
              />
            ) : (
              <AppTextInput
                accessibilityLabel={field.label}
                value={fields[field.variable] ?? ""}
                onChangeText={(value) => setFields({ ...fields, [field.variable]: value })}
                editable={!busy}
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
