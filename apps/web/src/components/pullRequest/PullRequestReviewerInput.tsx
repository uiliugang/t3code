import { useAtomValue } from "@effect/atom-react";
import { parseReviewerIds } from "@t3tools/client-runtime/pull-request-reviewers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestRef, SourceControlProviderKind } from "@t3tools/contracts";
import { UserPlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";

export function PullRequestReviewerInput({
  environmentId,
  reference,
  provider,
  allowed,
  removable,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  provider: SourceControlProviderKind;
  allowed: boolean;
  removable: boolean;
}) {
  const t = useUiTranslation();
  const inputId = useId();
  const canWrite = useAtomValue(
    pullRequestEnvironment.requestReviewers.permissionAtom(environmentId),
  );
  const request = useAtomCommand(pullRequestEnvironment.requestReviewers, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const ids = parseReviewerIds(query);
  const tooMany = ids.length > 25;
  const enabled = allowed && canWrite;
  const update = async (requested: boolean) => {
    if (!enabled || inFlight.current || ids.length === 0 || tooMany) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await request({
      environmentId,
      input: { ...reference, reviewers: ids.map((id) => ({ id, kind: "user" })), requested },
    });
    inFlight.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(
        t(
          readableFailure(
            squashAtomCommandFailure(result),
            t("Couldn't update this review request. Try again."),
          ),
        ),
      );
      return;
    }
    setQuery("");
    setOpen(false);
    toastManager.add({
      type: "success",
      title: t(
        requested ? "Review requested from {login}" : "Review request to {login} taken back",
        { login: ids.join(", ") },
      ),
    });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("Request a review")}
            title={t("Request a review")}
            disabled={!enabled}
          />
        }
      >
        <UserPlusIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup width="md" align="start" keepMounted>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void update(true);
          }}
        >
          <PopoverTitle>{t("Request a review")}</PopoverTitle>
          <label htmlFor={inputId} className="text-xs font-medium">
            {t(provider === "meituan" ? "Reviewer MIS" : "Reviewer IDs")}
          </label>
          <Input
            id={inputId}
            aria-describedby={`${inputId}-error`}
            placeholder={t(
              provider === "meituan" ? "mis1, mis2" : "Reviewer login or ID, separated by commas",
            )}
            value={query}
            disabled={busy}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={tooMany || error !== null}
            onChange={(event) => {
              setQuery(event.target.value);
              setError(null);
            }}
          />
          {tooMany || error ? (
            <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
              {tooMany ? t("Add up to 25 reviewers at a time.") : error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {removable ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || ids.length === 0 || tooMany || !enabled}
                onClick={() => void update(false)}
              >
                {t("Remove review request")}
              </Button>
            ) : null}
            <Button
              type="submit"
              size="sm"
              disabled={busy || ids.length === 0 || tooMany || !enabled}
            >
              <UserPlusIcon />
              {t(busy ? "Adding..." : "Add reviewers")}
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
