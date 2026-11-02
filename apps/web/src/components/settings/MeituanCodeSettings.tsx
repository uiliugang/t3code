import { useAtomValue } from "@effect/atom-react";
import {
  SourceControlProviderKind,
  type EnvironmentId,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import { readMeituanCodeMis as readMis } from "@t3tools/client-runtime/source-control-clients";
import { useEffect, useEffectEvent, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";

export function MeituanCodeAuthorizationObserver(props: {
  readonly environmentId: EnvironmentId;
  readonly pending: boolean;
  readonly onChanged: () => void;
}) {
  const canWait = useAtomValue(
    sourceControlEnvironment.waitForSignIn.permissionAtom(props.environmentId),
  );
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const observe = useEffectEvent(async (environmentId: EnvironmentId, isActive: () => boolean) => {
    await wait({
      environmentId,
      input: { provider: SourceControlProviderKind.make("meituan"), host: "git.sankuai.com" },
    });
    if (isActive()) props.onChanged();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the server-owned authorization process without polling or keeping a collapsed form mounted
  useEffect(() => {
    if (!props.pending || !canWait) return;
    let active = true;
    void observe(props.environmentId, () => active);
    return () => {
      active = false;
    };
  }, [props.environmentId, props.pending, canWait]);
  return null;
}

export function MeituanCodeSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SourceControlProviderDiscoveryItem;
  readonly onChanged: () => void;
}) {
  const t = useUiTranslation();
  const saved = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.sourceControlHosts.meituan,
  );
  const savedMis = readMis(saved);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? savedMis;
  const mis = readMis({ mis: value });
  const dirty = value.trim() !== savedMis;
  const pending = props.item.authorization?.status === "pending";
  const canSave = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const canSignIn = useAtomValue(
    sourceControlEnvironment.startSignIn.permissionAtom(props.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.cancelSignIn, { reportFailure: false });
  const errorMessage = error ?? (savedMis ? props.item.authorization?.detail : null);
  const attempted =
    Array.isArray(saved?.authorizationAttemptedMis) &&
    saved.authorizationAttemptedMis.includes(savedMis);
  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: { patch: { sourceControlHosts: { meituan: { mis } } } },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setDraft(null);
      props.onChanged();
    } else setError("Could not save the MIS ID. Try again.");
  };
  const request = async () => {
    setBusy(true);
    setError(null);
    const result = await (pending ? cancel : start)({
      environmentId: props.environmentId,
      input: { provider: props.item.kind, host: "git.sankuai.com" },
    });
    setBusy(false);
    if (result._tag !== "Success")
      setError("Could not start authorization. Rescan the server and try again.");
    props.onChanged();
  };
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && (mis || !value.trim())) void save();
      }}
    >
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
        {t(
          "Save your MIS ID to receive authorization requests in DaXiang. The first unauthenticated check sends one request automatically; send later requests manually.",
        )}
      </p>
      <div className="grid gap-1.5 sm:max-w-sm">
        <Label htmlFor={`meituan-mis-${props.environmentId}`}>{t("MIS ID")}</Label>
        <Input
          id={`meituan-mis-${props.environmentId}`}
          size="sm"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          placeholder={t("Enter your MIS ID")}
          value={value}
          disabled={!canSave || busy || pending}
          onChange={(event) => setDraft(event.target.value)}
          aria-invalid={Boolean(value.trim() && !mis)}
          aria-describedby={`meituan-mis-hint-${props.environmentId}`}
        />
        <p id={`meituan-mis-hint-${props.environmentId}`} className="text-xs text-muted-foreground">
          {t(
            value.trim() && !mis
              ? "Use letters, numbers, dots, underscores or hyphens, starting with a letter."
              : "No authorization requests are sent without a saved MIS ID. Clear it and save to stop future requests.",
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            pending
              ? "Authorization in progress. Confirm the request in DaXiang when it arrives."
              : props.item.auth.status === "authenticated"
                ? "Authenticated"
                : attempted
                  ? "The automatic request has been used. Send another request manually if needed."
                  : "Save a MIS ID to enable the first automatic authorization request.",
          )}
        </p>
        <div className="flex shrink-0 gap-2">
          {props.item.auth.status !== "authenticated" || pending ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={
                !canSignIn ||
                busy ||
                (!pending && (!savedMis || dirty || props.item.status !== "available"))
              }
              onClick={() => void request()}
            >
              {busy ? <Spinner /> : null}
              {t(
                pending
                  ? "Cancel authorization"
                  : attempted
                    ? "Send again"
                    : "Send authorization request",
              )}
            </Button>
          ) : null}
          <Button
            type="submit"
            size="xs"
            disabled={!canSave || busy || pending || !dirty || Boolean(value.trim() && !mis)}
          >
            {t("Save")}
          </Button>
        </div>
      </div>
      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive">
          {t(errorMessage)}
        </p>
      ) : null}
    </form>
  );
}
