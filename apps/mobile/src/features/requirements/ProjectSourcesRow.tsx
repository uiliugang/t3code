import {
  parseMepSpaceIds,
  projectIssueSourceEdit,
  withGithubRepositoryOverride,
  withMepSpaceOverrides,
} from "@t3tools/client-runtime/issueSources";
import { mepSpaceValue } from "@t3tools/client-runtime/meituanSettings";
import type { EnvironmentId, IssueProvider, IssueSource, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { Sheet } from "../../components/ui/Sheet";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type SourceEdit = { provider: "meituan" } | { provider: "github"; source: IssueSource | undefined };

export function ProjectSourcesRow({
  environmentId,
  projectId,
  title,
  repository,
  saved,
  sources,
  provider,
  error,
  discovery,
  mep,
  allowed,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  repository: string | null;
  saved: readonly IssueSource[];
  sources: readonly IssueSource[];
  provider: IssueProvider | undefined;
  error: string | undefined;
  discovery: "pending" | "failed" | "ready";
  mep: boolean;
  allowed: boolean;
}) {
  const t = useUiTranslation();
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [view, setView] = useState<
    "closed" | "sources" | (SourceEdit & { saved: readonly IssueSource[] })
  >("closed");
  const editing = typeof view === "object" ? view : null;
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const githubSources = sources.filter((s) => s.provider === "github");
  const spaces = sources.filter((s) => s.provider === "meituan").map((s) => s.scope);
  const manual = saved.some((s) => s.provider === "meituan");
  const github = githubSources[0];
  const canChoose = provider !== undefined || discovery === "ready";
  const showGithub = canChoose && provider !== "meituan";
  const showMep = canChoose && mep && provider !== "github";
  const space = mep ? spaces[0] : undefined;
  const githubLabel =
    githubSources.length > 1
      ? t("{count} GitHub repositories", { count: githubSources.length })
      : github
        ? github.host === "github.com"
          ? github.scope
          : `${github.host}/${github.scope}`
        : undefined;
  const mepLabel = space
    ? spaces.length > 1
      ? t("{count} MEP spaces", { count: spaces.length })
      : t("MEP {space}", { space })
    : undefined;
  const status =
    discovery === "failed"
      ? t("Source discovery failed")
      : discovery === "pending"
        ? t("Loading...")
        : undefined;
  const repositorySummary = [status, githubLabel].filter(Boolean).join(" · ");
  const valid =
    editing?.provider === "meituan"
      ? parseMepSpaceIds(draft) !== null
      : draft.trim().length <= 200 && /^[\w.-]+\/[\w.-]+$/u.test(draft.trim());
  const edit = (target: SourceEdit) => {
    setView({ ...target, saved });
    setDraft(target.provider === "meituan" ? spaces.join(", ") : (target.source?.scope ?? ""));
    setFailure(null);
  };
  const close = () => setView("closed");
  const open = () => {
    if (allowed && showGithub && !showMep && githubSources.length <= 1)
      edit({ provider: "github", source: github });
    else setView("sources");
  };
  const save = async (restore: boolean) => {
    if (
      !editing ||
      busy ||
      !allowed ||
      (!restore && !valid) ||
      !(editing.provider === "meituan" ? showMep : showGithub)
    )
      return;
    const input = projectIssueSourceEdit(
      projectId,
      editing.provider,
      saved,
      editing.saved,
      (latest) =>
        editing.provider === "meituan"
          ? withMepSpaceOverrides(restore ? [] : (parseMepSpaceIds(draft) ?? []))
          : withGithubRepositoryOverride(latest, editing.source, restore ? null : draft.trim()),
    );
    if (!input) {
      setFailure(t("Project sources have changed. Reopen the editor and try again."));
      return;
    }
    setBusy(true);
    setFailure(null);
    const result = await update({ environmentId, input });
    if (result._tag === "Success") {
      close();
    } else setFailure(t("Could not save project sources. Reopen the editor and try again."));
    setBusy(false);
  };
  return (
    <>
      <View className="min-h-16 flex-row items-center gap-2 py-2 pr-2 pl-4">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} textRole="body" className="font-t3-semibold">
            {title}
          </Text>
          <View className="flex-row items-center">
            <Text numberOfLines={1} textRole="footnote" className="shrink text-foreground-muted">
              {repositorySummary || mepLabel || t("Not configured")}
            </Text>
            {repositorySummary && mepLabel ? (
              <Text
                numberOfLines={1}
                textRole="footnote"
                className="max-w-1/2 text-foreground-muted"
              >
                {" · "}
                {mepLabel}
              </Text>
            ) : null}
          </View>
        </View>
        <IconButton
          icon={allowed ? "pencil" : "info.circle"}
          iconScale={0.85}
          tintColorClassName="accent-foreground-muted"
          accessibilityLabel={t(allowed ? "Edit {name}" : "View sources for {name}", {
            name: title,
          })}
          onPress={open}
        />
      </View>
      {view !== "closed" ? (
        <Sheet title={title} onClose={close} dismissDisabled={busy}>
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-4 px-5 pt-4 pb-12"
          >
            {repository && !githubSources.some((source) => source.scope === repository) ? (
              <Text textRole="footnote" className="text-foreground-muted">
                {t("Git: {repository}", { repository })}
              </Text>
            ) : null}
            {error ? (
              <Text accessibilityRole="alert" className="text-danger">
                {error}
              </Text>
            ) : null}
            {editing && allowed ? (
              <View className="gap-2">
                <Text textRole="footnote" className="font-t3-medium">
                  {t(editing.provider === "meituan" ? "MEP space IDs" : "GitHub repository")}
                  {editing.provider === "github"
                    ? ` · ${editing.source?.host ?? "github.com"}`
                    : ""}
                  {editing.provider === "meituan" && spaces.length
                    ? ` · ${t(manual ? "Manual override" : "Automatic")}`
                    : ""}
                </Text>
                <AppTextInput
                  accessibilityLabel={t(
                    editing.provider === "meituan" ? "MEP space IDs" : "GitHub repository",
                  )}
                  value={draft}
                  onChangeText={setDraft}
                  editable={allowed && !busy}
                  placeholder={editing.provider === "meituan" ? "10001, 10002" : "owner/repository"}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {!valid && editing.provider === "meituan" ? (
                  <Text className="text-sm text-danger">
                    {t("Enter positive space IDs separated by commas.")}
                  </Text>
                ) : null}
                {failure ? (
                  <Text accessibilityRole="alert" className="text-danger">
                    {failure}
                  </Text>
                ) : null}
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    size="compact"
                    label={t("Save")}
                    tone="primary"
                    disabled={!valid || busy || !allowed}
                    onPress={() => void save(false)}
                  />
                  <Button
                    size="compact"
                    label={t("Cancel")}
                    tone="text"
                    disabled={busy}
                    onPress={close}
                  />
                  {saved.some((s) => s.provider === editing.provider) ? (
                    <Button
                      size="compact"
                      label={t(
                        editing.provider === "github" && githubSources.length > 1
                          ? "Remove"
                          : "Restore automatic",
                      )}
                      tone="text"
                      disabled={!allowed || busy}
                      onPress={() => void save(true)}
                    />
                  ) : null}
                </View>
              </View>
            ) : (
              <>
                {showGithub ? (
                  <ListSection title={t("GitHub repository")}>
                    {(githubSources.length ? githubSources : [undefined]).map((source) => (
                      <SourceChoice
                        key={source ? JSON.stringify([source.host, source.scope]) : "github"}
                        label={
                          source?.scope ??
                          t(
                            discovery === "pending"
                              ? "Loading..."
                              : discovery === "failed"
                                ? "Unknown"
                                : "Not configured",
                          )
                        }
                        description={source?.host}
                        onEdit={allowed ? () => edit({ provider: "github", source }) : undefined}
                      />
                    ))}
                  </ListSection>
                ) : null}
                {showMep ? (
                  <ListSection title={t("MEP space IDs")}>
                    <SourceChoice
                      label={mepSpaceValue(spaces, discovery, t)}
                      description={
                        spaces.length ? t(manual ? "Manual override" : "Automatic") : undefined
                      }
                      onEdit={allowed ? () => edit({ provider: "meituan" }) : undefined}
                    />
                  </ListSection>
                ) : null}
              </>
            )}
          </ScreenScrollView>
        </Sheet>
      ) : null}
    </>
  );
}

function SourceChoice({
  label,
  description,
  onEdit,
}: {
  label: string;
  description: string | undefined;
  onEdit: (() => void) | undefined;
}) {
  return onEdit ? (
    <ListRow label={label} description={description} onPress={onEdit} />
  ) : (
    <ListRowLayout label={label} description={description} />
  );
}
