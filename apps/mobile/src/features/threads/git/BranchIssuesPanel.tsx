import { useAtomValue } from "@effect/atom-react";
import {
  branchIssuePlaceholder,
  isMeituanServiceEnabled,
  parseBranchIssueUrl,
  type BranchIssue,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Linking, View } from "react-native";
import { AppText, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListRow } from "../../../components/ui/ListRow";
import { IconButton } from "../../../components/ui/IconButton";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import { SelectableMarkdownText } from "../../../native/SelectableMarkdownText";
import { mobilePreferencesAtom } from "../../../state/preferences";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { useEnvironmentQuery } from "../../../state/query";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../../files/FileMarkdownPreview";

type Target = { environmentId: EnvironmentId; cwd: string; branch: string };

function IssueBody({ target, issue }: { target: Target; issue: BranchIssue }) {
  const t = useUiTranslation();
  const styles = useMarkdownPreviewStyles();
  const query = useEnvironmentQuery(
    sourceControlEnvironment.branchIssueDetail({
      environmentId: target.environmentId,
      input: { cwd: target.cwd, branch: target.branch, url: issue.url },
    }),
  );
  if (query.error) return <Button label={t("Retry")} onPress={query.refresh} />;
  return query.data ? (
    <SelectableMarkdownText
      markdown={query.data.body || t("No description.")}
      textStyle={styles.nativeTextStyle}
      onLinkPress={(url) => {
        if (/^https?:\/\//i.test(url)) void Linking.openURL(url);
      }}
    />
  ) : (
    <AppText>{t("Loading...")}</AppText>
  );
}

function IssueRow({
  issue,
  target,
  expandedInitially,
  allowed,
  busy,
  remove,
}: {
  issue: BranchIssue;
  target: Target;
  expandedInitially: boolean;
  allowed: boolean;
  busy: boolean;
  remove: () => void;
}) {
  const t = useUiTranslation();
  const [expanded, setExpanded] = useState(expandedInitially);
  return (
    <View>
      <View className="flex-row items-start pr-3">
        <View className="min-w-0 flex-1">
          <ListRow
            label={issue.title}
            description={`${issue.provider === "meituan" ? "MEP ONES" : issue.repository} #${issue.id} · ${issue.state}`}
            onPress={() => setExpanded(!expanded)}
          />
        </View>
        <IconButton
          accessibilityLabel={t("View original")}
          icon="arrow.up.right"
          onPress={() => void Linking.openURL(issue.url)}
        />
      </View>
      {expanded ? (
        <View className="gap-3 px-4 pb-4">
          <IssueBody target={target} issue={issue} />
          <View className="flex-row flex-wrap gap-2">
            <Button label={t("Unlink issue")} disabled={!allowed || busy} onPress={remove} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function BranchIssuesPanel({
  target,
  provider,
  creationControl,
}: {
  target: Target;
  provider: string;
  creationControl?: ReactNode;
}) {
  const t = useUiTranslation();
  const config = useEnvironmentServerConfig(target.environmentId);
  const enabled =
    provider !== "meituan" ||
    (isMeituanServiceEnabled(config?.settings, "requirements") &&
      isMeituanServiceEnabled(config?.settings, "sourceControl"));
  const preferences = AsyncResult.getOrElse(
    useAtomValue(mobilePreferencesAtom),
    (): Preferences => ({}),
  );
  const query = useEnvironmentQuery(
    enabled
      ? sourceControlEnvironment.branchIssues({
          environmentId: target.environmentId,
          input: { cwd: target.cwd, branch: target.branch },
        })
      : null,
  );
  const allowed = useAtomValue(
    sourceControlEnvironment.updateBranchIssues.permissionAtom(target.environmentId),
  );
  const update = useAtomCommand(sourceControlEnvironment.updateBranchIssues);
  const [adding, setAdding] = useState(false);
  const [links, setLinks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(4);
  const issues = query.data?.issues ?? [];
  const unpublished = query.data?.published === false;
  async function mutate(urls: string[], action: "associate" | "disassociate") {
    if (!urls.length || urls.some((url) => parseBranchIssueUrl(url)?.provider !== provider)) {
      setError(t("Enter valid issue links for this repository's hosting platform."));
      return;
    }
    setBusy(true);
    const result = await update({
      environmentId: target.environmentId,
      input: { cwd: target.cwd, branch: target.branch, urls, action },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Success") {
      setAdding(false);
      setLinks("");
      setError(null);
    } else {
      const failure = squashAtomCommandFailure(result);
      setError(
        t(
          failure instanceof Error
            ? failure.message
            : "Some links could not be updated. Refresh and retry.",
        ),
      );
    }
  }
  if (
    !enabled ||
    preferences.branchIssuesVisible === false ||
    (preferences.branchIssuesShowEmpty === false && query.data && !issues.length && !adding)
  )
    return creationControl ? <View className="px-4 pb-2">{creationControl}</View> : null;
  return (
    <View>
      <View className="flex-row items-center justify-between gap-2 px-4 py-2">
        <AppText>
          {t("Linked issues")} · {issues.length}
        </AppText>
        <Button
          label={t("Link issues")}
          disabled={!allowed || busy || !query.data || unpublished || issues.length > 0}
          accessibilityHint={
            issues.length > 0
              ? t("Each branch can link one issue. Unlink the existing issue first.")
              : undefined
          }
          onPress={() => setAdding(!adding)}
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2">
        {creationControl ? <View className="min-w-0 shrink-0">{creationControl}</View> : null}
        {query.data && !unpublished && !issues.length ? (
          <AppText className="text-xs text-foreground-muted">
            {t("No issues linked to this branch.")}
          </AppText>
        ) : null}
      </View>
      {unpublished ? (
        <AppText className="px-4 pb-3 text-foreground-muted">
          {t("Push this branch before linking an issue.")}
        </AppText>
      ) : null}
      {query.error ? (
        <View className="px-4 py-2">
          <AppText>{t("Could not load linked issues.")}</AppText>
          <Button label={t("Retry")} onPress={query.refresh} />
        </View>
      ) : null}
      {issues.slice(0, limit).map((issue) => (
        <IssueRow
          key={issue.url}
          issue={issue}
          target={target}
          expandedInitially={preferences.branchIssuesExpanded ?? false}
          allowed={allowed}
          busy={busy}
          remove={() => void mutate([issue.url], "disassociate")}
        />
      ))}
      {issues.length > limit ? (
        <Button label={t("Show more")} onPress={() => setLimit(limit + 10)} />
      ) : null}
      {adding && !unpublished && issues.length === 0 ? (
        <View className="gap-2 p-4">
          <AppTextInput
            accessibilityLabel={t("Issue links")}
            autoCapitalize="none"
            autoCorrect={false}
            value={links}
            onChangeText={setLinks}
            placeholder={t(branchIssuePlaceholder(provider))}
            editable={!busy}
            className="rounded-lg bg-subtle px-3 py-2 text-base"
          />
          <View className="flex-row justify-end gap-2">
            <Button label={t("Cancel")} disabled={busy} onPress={() => setAdding(false)} />
            <Button
              label={t(busy ? "Linking..." : "Link issues")}
              disabled={!allowed || busy || !links.trim()}
              onPress={() =>
                void mutate(
                  links
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean),
                  "associate",
                )
              }
            />
          </View>
        </View>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" className="px-4 py-2 text-destructive">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}
