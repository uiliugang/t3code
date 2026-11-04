import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Pressable, View } from "react-native";
import type { PullRequestDetail, PullRequestComment } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { useUiTranslation } from "../../lib/useUiTranslation";

export function PullRequestSendReviewLink({
  pr,
  params,
  reviews,
}: {
  pr: PullRequestDetail;
  params: PullRequestParams;
  reviews: ReadonlyArray<PullRequestComment>;
}) {
  const target = pullRequestTarget(params);
  const t = useUiTranslation();
  const allowed = useAtomValue(
    composerPullRequests.sendReviewLink.permissionAtom(target.environmentId),
  );
  const send = useAtomCommand(composerPullRequests.sendReviewLink, { reportFailure: false });
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const selected = selection.filter((mis) => pr.reviewers.some((actor) => actor.login === mis));
  return (
    <View className="gap-3 px-4 py-2">
      {pr.reviewers.map((actor) => (
        <Pressable
          key={actor.login}
          accessibilityRole="checkbox"
          accessibilityLabel={actor.login}
          accessibilityState={{
            checked: selected.includes(actor.login),
            disabled: !allowed || busy,
          }}
          disabled={!allowed || busy}
          onPress={() =>
            setSelection(
              selected.includes(actor.login)
                ? selected.filter((mis) => mis !== actor.login)
                : [...selected, actor.login],
            )
          }
          className="min-h-12 flex-row items-center gap-3"
        >
          <SymbolView
            name={selected.includes(actor.login) ? "checkmark.circle.fill" : "circle"}
            size={20}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="min-w-0 flex-1 text-sm font-t3-medium">{actor.login}</Text>
          <Text className="text-xs text-foreground-muted">
            {(() => {
              const state = reviews.find(
                (review) => review.author?.login === actor.login,
              )?.reviewState;
              return t(
                state === "APPROVED"
                  ? "Approved"
                  : state === "CHANGES_REQUESTED"
                    ? "Changes requested"
                    : state === "COMMENTED"
                      ? "Commented"
                      : "Review requested",
              );
            })()}
          </Text>
        </Pressable>
      ))}
      {selected.length > 0 ? (
        <Button
          label={`${t("Send PR link")} (${selected.length})`}
          icon="square.and.arrow.up"
          disabled={!allowed}
          loading={busy}
          onPress={() => {
            setBusy(true);
            setStatus(null);
            void send({ ...target, input: { ...target.input, reviewerMis: selected } }).then(
              (result) => {
                setBusy(false);
                if (result._tag !== "Success") {
                  setStatus(
                    "Delivery could not be confirmed. Check DaXiang and the application's credentials before resending.",
                  );
                  return;
                }
                setSelection(
                  result.value.recipients
                    .filter((entry) => entry.status === "failed")
                    .map((entry) => entry.mis),
                );
                setStatus(
                  result.value.recipients
                    .map(
                      (entry) =>
                        `${entry.mis}: ${entry.status === "unknown" ? "delivery unknown; check DaXiang before resending" : entry.status}`,
                    )
                    .join("\n"),
                );
              },
            );
          }}
        />
      ) : null}
      {status ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {status}
        </Text>
      ) : null}
    </View>
  );
}
