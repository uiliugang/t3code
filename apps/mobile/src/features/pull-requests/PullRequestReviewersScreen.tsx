import { useUiTranslation } from "../../lib/useUiTranslation";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { AppBar, type AppBarSearch } from "../../components/ui/AppBar";
import { AsyncResult } from "effect/reactivity";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  hostReviewerQuery,
  parseReviewerIds,
  reviewerCandidateView,
  type ReviewerTruncation,
} from "@t3tools/client-runtime/pull-request-reviewers";
import {
  emptySelection,
  isSelected,
  changeBatches,
  selectionChanges,
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";
import { PullRequestOperationError, type PullRequestReviewerCandidate } from "@t3tools/contracts";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useContentTopInset, useSearchToolbarInset } from "../../components/ui/useBarInset";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

const isPullRequestOperationError = Schema.is(PullRequestOperationError);

const TRUNCATED_LABELS: Record<ReviewerTruncation, (error: string | null) => string> = {
  unsearchable: () =>
    "The provider has more reviewers than it returned. Find additional reviewers on the provider.",
  searchable: () => "The provider has more reviewers than are listed here. Search to find them.",
  "search-failed": (error) =>
    `Only listed reviewers are matched: the provider search failed. ${error ?? ""}`,
  "search-truncated": () =>
    "More reviewers match than the provider returned. Keep typing to narrow it down.",
};

export function PullRequestReviewersScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const contentTopInset = useContentTopInset();
  const listRef = useRef<LegendListRef>(null);
  const target = pullRequestTarget(route.params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const pr = detail.data;
  const { singular } = sourceControlClients.get(
    (pr ?? route.params.initialSummary)?.provider,
  ).changeRequest;
  const canWrite = useAtomValue(
    composerPullRequests.requestReviewers.permissionAtom(target.environmentId),
  );
  const connected = usePullRequestConnected(route.params.environmentId);
  const allowed =
    connected &&
    canWrite &&
    pr?.state === "open" &&
    pr.capabilities.reviewers.request &&
    pr.viewerPermissions.requestReviewers;
  const result = useEnvironmentQuery(
    pr?.capabilities.reviewers.listCandidates
      ? composerPullRequests.reviewerCandidates(target)
      : null,
  );
  const request = useAtomCommand(composerPullRequests.requestReviewers, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [draft, setDraft] = useState(emptySelection<PullRequestReviewerCandidate>);
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const searchInput = {
    loaded: result.data,
    searchable: pr?.capabilities.reviewers.searchCandidates === true,
    query,
    debouncedQuery,
  };
  const hostQuery = hostReviewerQuery(searchInput);
  const searchResult = useEnvironmentQuery(
    hostQuery !== null
      ? composerPullRequests.reviewerSearch({
          ...target,
          input: { ...target.input, query: hostQuery },
        })
      : null,
  );
  const view = reviewerCandidateView({
    ...searchInput,
    search: searchResult,
  });
  const candidates = [...view.candidates].sort(
    (a, b) => Number(b.isRequested) - Number(a.isRequested) || a.login.localeCompare(b.login),
  );
  const queryError = result.error ?? view.searchError;
  // A new search shows its best matches from the top.
  const search = (next: string) => {
    setQuery(next);
    listRef.current?.scrollToOffset({
      offset: -contentTopInset,
      animated: false,
    });
  };
  const update = async (
    candidate: Pick<PullRequestReviewerCandidate, "id" | "kind" | "isRequested">,
    fromInput = false,
  ) => {
    if (!allowed || inFlight.current) return;
    const ids = parseReviewerIds(query);
    const manual = fromInput || !pr?.capabilities.reviewers.listCandidates;
    if (manual && (ids.length === 0 || ids.length > 25)) return;
    if (candidate.isRequested && pr?.capabilities.reviewers.remove === false) return;
    inFlight.current = true;
    setPending(`${candidate.kind}:${candidate.id}`);
    setError(null);
    const response = await request({
      ...target,
      input: {
        ...target.input,
        reviewers: manual
          ? ids.map((id) => ({ id, kind: "user" }))
          : [{ id: candidate.id, kind: candidate.kind }],
        requested: !candidate.isRequested,
      },
    });
    inFlight.current = false;
    setPending(null);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      setError(
        t(
          isPullRequestOperationError(cause)
            ? cause.detail
            : cause instanceof Error
              ? cause.message
              : "Couldn't update this review request. Try again.",
        ),
      );
      return;
    }
    if (hostQuery !== null) searchResult.refresh();
    search("");
    detail.refresh();
  };
  const listCandidates = pr?.capabilities.reviewers.listCandidates === true;
  // Loaded rows first: they carry the request state mutations update.
  const latest = [...(result.data?.candidates ?? []), ...(searchResult.data?.candidates ?? [])];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- picks are sent when the sheet leaves the navigation stack, however it is dismissed
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        const { add, remove } = selectionChanges(
          draft,
          (key, person) =>
            latest.find((entry) => `${entry.kind}:${entry.id}` === key)?.isRequested ??
            person.isRequested,
        );
        const sendBatch = async (
          people: ReadonlyArray<PullRequestReviewerCandidate>,
          requested: boolean,
        ) => {
          const response = await request({
            ...target,
            input: {
              ...target.input,
              reviewers: people.map(({ id, kind }) => ({ id, kind })),
              requested,
            },
          });
          if (!AsyncResult.isFailure(response)) return;
          const cause = squashAtomCommandFailure(response);
          const logins = people.map((person) => person.login).join(", ");
          Dialog.alert(
            requested
              ? `Couldn't request a review from ${logins}`
              : `Couldn't remove the review request from ${logins}`,
            cause instanceof Error ? cause.message : "The provider refused the change.",
          );
        };
        const send = async (
          people: ReadonlyArray<PullRequestReviewerCandidate>,
          requested: boolean,
        ) => {
          for (const batch of changeBatches(people)) await sendBatch(batch, requested);
        };
        // A search result is keyed by what was typed, so the writes do not reach it on their own.
        const refreshSearch =
          hostQuery !== null && add.length + remove.length > 0 ? searchResult.refresh : null;
        // Removing first lets a host that keeps one reviewer take the new one.
        void send(remove, false)
          .then(() => send(add, true))
          .then(() => refreshSearch?.());
      }),
    [navigation, draft, latest, request, target, hostQuery, searchResult.refresh],
  );
  const reviewerIds = parseReviewerIds(query);
  const tooMany = reviewerIds.length > 25;
  const manualWithCandidates = pr?.provider === "meituan";
  const reviewerSearch: AppBarSearch | undefined =
    listCandidates && !manualWithCandidates
      ? {
          mode: "inline",
          compactToolbar: true,
          value: query,
          onChangeText: search,
          placeholder: t("Search reviewers"),
        }
      : undefined;
  const searchToolbarInset = useSearchToolbarInset(reviewerSearch);
  const manualControls = pr ? (
    <View className="gap-3">
      <Text className="text-sm text-foreground-muted">
        {t(pr.provider === "meituan" ? "Reviewer MIS" : "Reviewer IDs")}
      </Text>
      <TextInput
        accessibilityLabel={t(pr.provider === "meituan" ? "Reviewer MIS" : "Reviewer IDs")}
        placeholder={t(
          pr.provider === "meituan" ? "mis1, mis2" : "Reviewer login or ID, separated by commas",
        )}
        placeholderTextColorClassName="accent-foreground-muted"
        value={query}
        onChangeText={(value) => {
          search(value);
          setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        editable={pending === null}
        className="min-h-12 rounded-xl bg-grouped-card px-3 text-base"
      />
      <Button
        label={t("Add reviewers")}
        fullWidth
        disabled={!allowed || reviewerIds.length === 0 || tooMany || pending !== null}
        onPress={() => void update({ id: query.trim(), kind: "user", isRequested: false }, true)}
      />
      {pr.capabilities.reviewers.remove !== false ? (
        <Button
          label={t("Remove review request")}
          fullWidth
          tone="text"
          disabled={!allowed || reviewerIds.length === 0 || tooMany || pending !== null}
          onPress={() => void update({ id: query.trim(), kind: "user", isRequested: true }, true)}
        />
      ) : null}
      {tooMany || error ? (
        <Text selectable className="text-danger-foreground">
          {tooMany ? t("Add up to 25 reviewers at a time.") : error}
        </Text>
      ) : null}
    </View>
  ) : null;
  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title={t("Request review")}
        subtitle={`#${route.params.number} · ${route.params.repository}`}
        onClose={() => navigation.goBack()}
        closeAccessibilityLabel={t("Close request review")}
        search={reviewerSearch}
      />
      {listCandidates ? (
        <LegendList
          ref={listRef}
          data={candidates}
          keyExtractor={(candidate) => `${candidate.kind}:${candidate.id}`}
          extraData={{ allowed, draft }}
          estimatedItemSize={64}
          recycleItems
          renderScrollComponent={NativeScrollView}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 + searchToolbarInset }}
          ListHeaderComponent={
            <View className="gap-3 px-4 py-4">
              {manualWithCandidates ? (
                <>
                  {manualControls}
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    {t("Default reviewers")}
                  </Text>
                </>
              ) : (
                <Text className="text-xs text-foreground-muted">
                  {t(
                    "Tap someone to request a review. Tap a requested reviewer to remove the request.",
                  )}
                </Text>
              )}
              {!allowed ? (
                <Text className="text-xs text-foreground-muted">
                  {t("Requesting reviews requires write access and an open {type}.", {
                    type: t(singular),
                  })}
                </Text>
              ) : null}
              {error && !manualWithCandidates ? (
                <Text selectable className="text-sm text-danger-foreground">
                  {error}
                </Text>
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            const id = `${item.kind}:${item.id}`;
            const requested = isSelected(draft, id, item.isRequested);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${requested ? "Remove review request from" : "Request review from"} ${item.login}${item.kind === "team" ? " team" : ""}`}
                accessibilityState={{
                  disabled:
                    !allowed ||
                    pending !== null ||
                    (requested && item.isRequested && pr?.capabilities.reviewers.remove === false),
                }}
                disabled={
                  !allowed ||
                  pending !== null ||
                  (requested && item.isRequested && pr?.capabilities.reviewers.remove === false)
                }
                onPress={() =>
                  setDraft((current) => toggleSelection(current, id, item, item.isRequested))
                }
                className="min-h-16 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
              >
                <PullRequestAvatar actor={item} size={32} />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-sm font-t3-medium" numberOfLines={1}>
                    {item.name || item.login}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {item.login}
                    {item.kind === "team" ? t(" · Team") : ""}
                  </Text>
                </View>
                {requested ? (
                  <View className="flex-row items-center gap-1.5">
                    <Text className="text-xs text-foreground-muted">{t("Requested")}</Text>
                    <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" />
                  </View>
                ) : (
                  <SymbolView name="plus" size={16} tintColorClassName="accent-icon-muted" />
                )}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            (result.isPending && !result.data) || view.searchPending ? (
              <AppActivityIndicator className="my-8" />
            ) : (
              <View className="px-4 py-6">
                <EmptyState
                  title={
                    queryError
                      ? t("Couldn't load reviewers")
                      : query.trim()
                        ? t(
                            manualWithCandidates
                              ? "No matching default reviewers"
                              : "No matching reviewers",
                          )
                        : t(
                            manualWithCandidates
                              ? "No default reviewers"
                              : "No reviewers available",
                          )
                  }
                  detail={
                    queryError ??
                    (manualWithCandidates
                      ? ""
                      : t("Search people and teams with access to this repository."))
                  }
                  variant="plain"
                />
                {queryError ? (
                  <Button
                    label={t("Retry")}
                    onPress={result.error ? result.refresh : searchResult.refresh}
                  />
                ) : null}
              </View>
            )
          }
          ListFooterComponent={
            view.truncation ? (
              <Text className="px-4 py-4 text-xs text-foreground-muted">
                {t(TRUNCATED_LABELS[view.truncation](view.searchError))}
              </Text>
            ) : undefined
          }
        />
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 16 }}
        >
          {!pr ? (
            detail.isPending ? (
              <AppActivityIndicator />
            ) : (
              <Text className="text-danger-foreground">
                {detail.error ?? t("Couldn't load this {singular}.", { singular: t(singular) })}
              </Text>
            )
          ) : (
            manualControls
          )}
        </ScrollView>
      )}
    </View>
  );
}
