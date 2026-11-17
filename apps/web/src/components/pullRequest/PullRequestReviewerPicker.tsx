import { useUiTranslation } from "~/hooks/useUiTranslation";
import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "~/state/use-atom-command";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewerCandidate,
  PullRequestReviewerRequestInput,
} from "@t3tools/contracts";
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
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";

const TRUNCATED_LABELS: Record<ReviewerTruncation, (error: string | null) => string> = {
  unsearchable: () =>
    "This repository has more people with access than are listed here. Ask for the rest on the host.",
  searchable: () =>
    "This repository has more people with access than are listed here. Search to find them.",
  "search-failed": (error) =>
    `Only the people already listed are matched: the host search failed. ${error ?? ""}`,
  "search-truncated": () =>
    "More people match than the host returned. Keep typing to narrow it down.",
};

export function PullRequestReviewerPicker({
  environmentId,
  reference,
  allowed,
  searchable,
  manualEntry = false,
  removable = true,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  allowed: boolean;
  searchable: boolean;
  manualEntry?: boolean;
  removable?: boolean;
}) {
  const t = useUiTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const canWrite = useAtomValue(
    pullRequestEnvironment.requestReviewers.permissionAtom(environmentId),
  );
  const enabled = allowed && canWrite;
  const ids = parseReviewerIds(query);
  const tooMany = ids.length > 25;
  const [draft, setDraft] = useState(emptySelection<PullRequestReviewerCandidate>);

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference }) : null,
  );
  // Past the first page the host is asked, since what was loaded cannot answer for the rest.
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const searchInput = { loaded: candidatesQuery.data, searchable, query, debouncedQuery };
  const hostQuery = hostReviewerQuery(searchInput);
  const searchResult = useEnvironmentQuery(
    open && hostQuery !== null
      ? pullRequestEnvironment.reviewerSearch({
          environmentId,
          input: { ...reference, query: hostQuery },
        })
      : null,
  );
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });

  const { candidates, searchPending, searchError, truncation } = reviewerCandidateView({
    ...searchInput,
    search: searchResult,
  });

  const update = async (
    reviewers: PullRequestReviewerRequestInput["reviewers"],
    requested: boolean,
  ) => {
    if (
      !enabled ||
      inFlight.current ||
      reviewers.length === 0 ||
      reviewers.length > 25 ||
      (!requested && !removable)
    )
      return;
    inFlight.current = true;
    setPending(reviewers.map((reviewer) => reviewer.id).join(", "));
    setError(null);
    const login = reviewers
      .map(
        (reviewer) =>
          candidates.find(
            (candidate) => candidate.id === reviewer.id && candidate.kind === reviewer.kind,
          )?.login ?? reviewer.id,
      )
      .join(", ");
    const result = await requestReviewers({
      environmentId,
      input: {
        ...reference,
        reviewers,
        requested,
      },
    });
    setPending(null);
    inFlight.current = false;
    if (result._tag === "Failure") {
      const description = t(
        readableFailure(
          squashAtomCommandFailure(result),
          t(
            "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
          ),
        ),
      );
      setError(description);
      toastManager.add({
        type: "error",
        title: requested
          ? t("Could not ask {login} for a review", { login })
          : t("Could not take back the review request to {login}", { login }),
        description,
      });
      return;
    }
    // The command reads the loaded list again only for somebody it lacked, and a search result
    // is keyed by what was typed, so the one on screen is read here or it keeps the old request.
    if (hostQuery !== null) searchResult.refresh();
    if (manualEntry) setQuery((current) => (current === query ? "" : current));
    toastManager.add({
      type: "success",
      title: requested
        ? t("Review requested from {login}", { login })
        : t("Review request to {login} taken back", { login }),
    });
  };

  const send = async (people: ReadonlyArray<PullRequestReviewerCandidate>, requested: boolean) => {
    if (!enabled || (!requested && !removable)) return;
    for (const batch of changeBatches(people)) {
      const result = await requestReviewers({
        environmentId,
        input: { ...reference, reviewers: batch.map(({ id, kind }) => ({ id, kind })), requested },
      });
      if (result._tag === "Success") continue;
      const login = batch.map((person) => person.login).join(", ");
      toastManager.add({
        type: "error",
        title: requested
          ? t("Could not ask {login} for a review", { login })
          : t("Could not take back the review request to {login}", { login }),
        description: readableFailure(
          squashAtomCommandFailure(result),
          t(
            "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
          ),
        ),
      });
    }
  };

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    // Loaded rows first: they carry the request state mutations update.
    const latest = [
      ...(candidatesQuery.data?.candidates ?? []),
      ...(searchResult.data?.candidates ?? []),
    ];
    const { add, remove } = selectionChanges(
      draft,
      (key, person) =>
        latest.find((entry) => `${entry.kind}:${entry.id}` === key)?.isRequested ??
        person.isRequested,
    );
    setDraft(emptySelection());
    // A search result is keyed by what was typed, so the writes do not reach it on their own.
    const refreshSearch =
      hostQuery !== null && add.length + remove.length > 0 ? searchResult.refresh : null;
    // Removing first lets a host that keeps one reviewer take the new one.
    void send(remove, false)
      .then(() => send(add, true))
      .then(() => refreshSearch?.());
  };

  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label={t("Request a review")}
      allowed={enabled}
      disabledReason={t("Asking someone to review needs write access on this repository")}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setError(null);
      }}
      searchLabel={t(manualEntry ? "Reviewer MIS" : "Search people with access")}
      listLabel={manualEntry ? t("Default reviewers") : undefined}
      onQuerySubmit={
        manualEntry
          ? () =>
              void update(
                ids.map((id) => ({ id, kind: "user" })),
                true,
              )
          : undefined
      }
      footer={
        manualEntry ? (
          <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
            {tooMany || error ? (
              <p role="alert" className="text-xs text-destructive">
                {tooMany ? t("Add up to 25 reviewers at a time.") : error}
              </p>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null || ids.length === 0 || tooMany || !enabled}
              onClick={() =>
                void update(
                  ids.map((id) => ({ id, kind: "user" })),
                  true,
                )
              }
            >
              <UserPlusIcon />
              {t(pending !== null ? "Adding..." : "Add reviewers")}
            </Button>
          </div>
        ) : undefined
      }
      isPending={(candidatesQuery.isPending && candidatesQuery.data === null) || searchPending}
      error={
        candidatesQuery.data === null
          ? candidatesQuery.error
          : candidates.length === 0
            ? searchError
            : null
      }
      candidates={candidates}
      emptyLabel={t(
        manualEntry ? "No default reviewers" : "Nobody else has access to this repository.",
      )}
      noMatchLabel={t(
        manualEntry ? "No matching default reviewers" : "Nobody with access matches that.",
      )}
      errorLabel={t("The people with access could not be read.")}
      truncated={truncation !== null}
      truncatedLabel={truncation === null ? "" : t(TRUNCATED_LABELS[truncation](searchError))}
      candidateKey={(candidate) => `${candidate.kind}:${candidate.id}`}
      disabled={pending !== null}
      candidateDisabled={(candidate: PullRequestReviewerCandidate) =>
        candidate.isRequested && !removable
      }
      onSelect={(candidate) =>
        setDraft((current) =>
          toggleSelection(
            current,
            `${candidate.kind}:${candidate.id}`,
            candidate,
            candidate.isRequested,
          ),
        )
      }
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} className="flex-1" />
          {candidate.kind === "team" ? (
            <span className="shrink-0 text-muted-foreground">{t("team")}</span>
          ) : null}
          {isSelected(draft, `${candidate.kind}:${candidate.id}`, candidate.isRequested) ? (
            <CheckIcon aria-label={t("Already asked")} className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}
