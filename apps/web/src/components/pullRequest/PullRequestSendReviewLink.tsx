import { useState, type ComponentProps } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { DaxiangSendError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { SendIcon } from "lucide-react";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Button } from "../ui/button";
const isSendError = Schema.is(DaxiangSendError);

function SendButton({
  environmentId,
  ...props
}: ComponentProps<typeof Button> & { environmentId: EnvironmentId }) {
  const allowed = useAtomValue(pullRequestEnvironment.sendReviewLink.permissionAtom(environmentId));
  return <Button {...props} disabled={props.disabled || !allowed} />;
}

export function PullRequestSendReviewLink({
  environmentId,
  reference,
  selected,
  onSent,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  selected: ReadonlyArray<string>;
  onSent: (sent: ReadonlyArray<string>) => void;
}) {
  const t = useUiTranslation();
  const send = useAtomCommand(pullRequestEnvironment.sendReviewLink, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  return (
    <>
      {selected.length > 0 ? (
        <SendButton
          environmentId={environmentId}
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            setSent(false);
            void send({ environmentId, input: { ...reference, reviewerMis: selected } }).then(
              (result) => {
                setBusy(false);
                if (result._tag !== "Success") {
                  const cause = squashAtomCommandFailure(result);
                  setError(
                    t(
                      isSendError(cause)
                        ? cause.message
                        : "Delivery could not be confirmed. Check DaXiang before resending.",
                    ),
                  );
                  return;
                }
                const sent = result.value.recipients
                  .filter((entry) => entry.status === "sent")
                  .map((entry) => entry.mis);
                onSent(
                  result.value.recipients
                    .filter((entry) => entry.status !== "failed")
                    .map((entry) => entry.mis),
                );
                setSent(sent.length > 0);
                const failed = result.value.recipients
                  .filter((entry) => entry.status === "failed")
                  .map((entry) => entry.mis);
                const unknown = result.value.recipients
                  .filter((entry) => entry.status === "unknown")
                  .map((entry) => entry.mis);
                setError(
                  [
                    failed.length ? `${t("Send failed")}: ${failed.join(", ")}` : "",
                    unknown.length
                      ? `${t("Delivery unknown; check DaXiang before resending")}: ${unknown.join(", ")}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(". ") || null,
                );
              },
            );
          }}
        >
          <SendIcon />
          {t(busy ? "Sending..." : "Send PR link")} ({selected.length})
        </SendButton>
      ) : null}
      {sent ? (
        <span role="status" className="text-xs text-muted-foreground">
          {t("PR link sent")}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </>
  );
}
