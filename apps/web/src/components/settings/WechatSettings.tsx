import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { ThreadId, type EnvironmentId, type WechatMutation } from "@t3tools/contracts";
import {
  wechatStatusMessages,
  wechatErrorMessages,
  wechatDeliveryMessages,
} from "@t3tools/shared/wechat";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { QRCodeSvg } from "../ui/qr-code";

export function WechatSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const t = useUiTranslation();
  const allowed = useAtomValue(serverEnvironment.mutateWechat.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    allowed ? serverEnvironment.wechat({ environmentId, input: {} }) : null,
  );
  const mutate = useAtomCommand(serverEnvironment.mutateWechat, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState("");
  const [thread, setThread] = useState<string | null>(null);
  const [push, setPush] = useState<boolean | null>(null);
  const [allThreads, setAllThreads] = useState<boolean | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [retry, setRetry] = useState<string | null>(null);
  const state = query.data;
  const selected = thread ?? state?.threadId ?? "";
  const pushEnabled = push ?? state?.pushEnabled ?? true;
  const pushAllThreads = allThreads ?? state?.pushAllThreads ?? false;
  const run = (input: WechatMutation) => {
    if (!allowed || busy) return;
    setBusy(true);
    setFailed(false);
    void mutate({ environmentId, input }).then((result) => {
      setBusy(false);
      setFailed(result._tag !== "Success");
      if (result._tag === "Success") {
        setConfirmUnlink(false);
        setRetry(null);
        if (input.type === "configure" || input.type === "unlink") {
          setThread(null);
          setPush(null);
          setAllThreads(null);
        }
      }
    });
  };
  return (
    <section className="grid gap-4 px-4 py-4" aria-label={t("WeChat")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="text-sm font-medium">
            {t("WeChat")} · {label}
          </h3>
          <p className="max-w-prose text-sm text-muted-foreground">
            {t("Continue a T3 thread from WeChat and receive results while you are away.")}
          </p>
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          {state
            ? t(wechatStatusMessages[state.status])
            : allowed
              ? t("Loading...")
              : t("Access management permission required.")}
        </p>
      </div>
      {(query.error || failed || state?.error) && (
        <div role="alert" className="grid gap-2 text-sm text-destructive">
          <p>
            {state?.error
              ? t(wechatErrorMessages[state.error])
              : t("Could not update WeChat. Check the connection and try again.")}
          </p>
          {query.error && (
            <div>
              <Button variant="outline" size="sm" onClick={query.refresh}>
                {t("Retry")}
              </Button>
            </div>
          )}
        </div>
      )}
      {state && !state.botId && !state.qrCode && (
        <div className="grid justify-items-start gap-3">
          <p className="max-w-prose text-sm text-muted-foreground">
            {t(
              "Pair with your WeChat account. Only the paired user can send tasks to the selected thread. Messages and results pass through WeChat.",
            )}
          </p>
          <Button size="sm" disabled={!allowed || busy} onClick={() => run({ type: "connect" })}>
            {t(
              busy
                ? "Connecting..."
                : state.status === "expired"
                  ? "Refresh pairing"
                  : "Connect WeChat",
            )}
          </Button>
        </div>
      )}
      {state?.qrCode && (
        <div className="flex flex-wrap items-start gap-5">
          <div className="shrink-0">
            <QRCodeSvg
              value={state.qrCode}
              size={176}
              marginSize={4}
              title={t("WeChat pairing QR code")}
            />
          </div>
          <div className="grid max-w-sm gap-3">
            <p className="text-sm">
              {t(
                "Scan with WeChat and confirm on your phone. After pairing, send the bot a message to activate this connection.",
              )}
            </p>
            {state.status === "verify" && (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  run({ type: "verify", code });
                }}
              >
                <Label htmlFor={`wechat-code-${environmentId}`}>
                  {t("Verification code shown on your phone")}
                </Label>
                <Input
                  id={`wechat-code-${environmentId}`}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 12))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
                <div>
                  <Button size="sm" type="submit" disabled={busy || !/^\d{1,12}$/u.test(code)}>
                    {t("Verify")}
                  </Button>
                </div>
              </form>
            )}
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => run({ type: "cancel" })}
              >
                {t("Cancel pairing")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {state?.botId && (
        <>
          {state.bindingCode && (
            <p className="text-sm">
              {t("Send /bind {code} to the bot in WeChat to verify your identity.", {
                code: state.bindingCode,
              })}
            </p>
          )}
          {!state.activated && (
            <p role="status" className="text-sm">
              {t("Paired. Send the bot a message in WeChat to activate replies.")}
            </p>
          )}
          <div className="grid gap-3 sm:max-w-lg">
            <Label htmlFor={`wechat-thread-${environmentId}`}>{t("Target thread")}</Label>
            <Select
              value={selected}
              onValueChange={(value) => setThread(value)}
              disabled={busy || !allowed}
            >
              <SelectTrigger id={`wechat-thread-${environmentId}`}>
                <SelectValue>
                  {state.targets.find((target) => target.threadId === selected)?.title ??
                    t("Select a thread")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {state.targets.map((target) => (
                  <SelectItem key={target.threadId} value={target.threadId}>
                    {target.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(
                "Incoming messages use this thread and its current permissions. Busy threads queue new tasks.",
              )}
            </p>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={`wechat-push-${environmentId}`}>{t("Push task results")}</Label>
              <Switch
                id={`wechat-push-${environmentId}`}
                checked={pushEnabled}
                disabled={busy || !allowed}
                onCheckedChange={setPush}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={`wechat-all-${environmentId}`}>
                {t("Include all threads and scheduled tasks in this project")}
              </Label>
              <Switch
                id={`wechat-all-${environmentId}`}
                checked={pushAllThreads}
                disabled={busy || !allowed || !pushEnabled}
                onCheckedChange={setAllThreads}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                "Results remain queued across server restarts. Keep this environment running for continuous delivery.",
              )}
            </p>
            <div>
              <Button
                size="sm"
                disabled={
                  busy ||
                  !allowed ||
                  !selected ||
                  (thread === null && push === null && allThreads === null)
                }
                onClick={() =>
                  run({
                    type: "configure",
                    threadId: ThreadId.make(selected),
                    pushEnabled,
                    pushAllThreads,
                  })
                }
              >
                {t("Save")}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !allowed}
              onClick={() => run({ type: "enabled", enabled: !state.enabled })}
            >
              {t(state.enabled ? "Pause WeChat" : "Resume WeChat")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !state.enabled || !state.activated}
              onClick={() => run({ type: "test" })}
            >
              {t("Send test push")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmUnlink(true)}
            >
              {t("Unlink")}
            </Button>
          </div>
          {confirmUnlink && (
            <div className="grid gap-3 rounded-lg border border-border p-3">
              <p className="text-sm">
                {t(
                  "Unlink WeChat? This removes local credentials and pending deliveries. Existing T3 tasks keep running.",
                )}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => run({ type: "unlink" })}
                >
                  {t("Unlink WeChat")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmUnlink(false)}>
                  {t("Cancel")}
                </Button>
              </div>
            </div>
          )}
          {state.deliveries.length > 0 && (
            <div className="grid gap-2">
              <h4 className="text-sm font-medium">{t("Recent deliveries")}</h4>
              <ul className="divide-y divide-border">
                {state.deliveries.slice(0, 5).map((delivery) => (
                  <li key={delivery.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <p className="min-w-0 flex-1 break-words">{delivery.preview}</p>
                    <span className="text-muted-foreground">
                      {t(wechatDeliveryMessages[delivery.status])}
                    </span>
                    {(delivery.status === "failed" || delivery.status === "unknown") && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || !state.enabled}
                        onClick={() =>
                          delivery.status === "unknown"
                            ? setRetry(delivery.id)
                            : run({ type: "retry", deliveryId: delivery.id })
                        }
                      >
                        {t("Retry")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {retry && (
            <div className="grid gap-2">
              <p className="text-sm">
                {t("The previous delivery may have arrived. Retrying can send a duplicate.")}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => run({ type: "retry", deliveryId: retry })}
                >
                  {t("Retry delivery")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setRetry(null)}>
                  {t("Cancel")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
