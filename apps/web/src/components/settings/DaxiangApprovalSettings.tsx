import { useState } from "react";
import { msg } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import type { DaxiangApprovalStatus, EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { readLocalApi } from "~/localApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

type MonitorSettings = ServerSettings["daxiang"]["approvalMonitor"];
type MonitorPatch = Partial<MonitorSettings>;

const statusMessages: Record<DaxiangApprovalStatus, string> = {
  disabled: msg("Monitoring disabled"),
  missing_cli: msg("dumbo-web is not installed"),
  unauthenticated: msg("DaXiang login required"),
  connecting: msg("Connecting to DaXiang"),
  listening: msg("Listening for approval links"),
  error: msg("Listener error"),
};
const outcomeMessages = {
  approved: msg("approved"),
  notified: msg("notified"),
  opened: msg("Browser opened"),
  localOnly: msg("Recorded locally only"),
  deliveryUnknown: msg("Delivery unknown"),
  skipped: msg("skipped"),
  failed: msg("failed"),
} as const;

export function DaxiangApprovalSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const monitor = useEnvironmentSettings(
    environmentId,
    (settings) => settings.daxiang.approvalMonitor,
  );
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canMutate = useAtomValue(
    serverEnvironment.mutateDaxiangApproval.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const mutate = useAtomCommand(serverEnvironment.mutateDaxiangApproval, { reportFailure: false });
  const query = useEnvironmentQuery(
    serverEnvironment.daxiangApproval({ environmentId, input: {} }),
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [drafts, setDrafts] = useState<{
    port?: string;
    prComment?: string;
    mcmComment?: string;
  }>({});
  const port = drafts.port ?? String(monitor.chromeCdpPort);
  const prComment = drafts.prComment ?? monitor.pullRequestComment;
  const mcmComment = drafts.mcmComment ?? monitor.mcmApproveComment;
  const editDraft = (key: "port" | "prComment" | "mcmComment", value: string) =>
    setDrafts((current) => ({ ...current, [key]: value }));
  const clearDraft = (key: "port" | "prComment" | "mcmComment") =>
    setDrafts((current) => ({ ...current, [key]: undefined }));
  const state = query.data;
  const portNumber = Number(port);
  const validPort = /^\d+$/u.test(port) && portNumber >= 1 && portNumber <= 65535;

  const save = async (patch: MonitorPatch) => {
    if (!allowed || busy) return;
    setBusy(true);
    setFailed(false);
    const result = await update({
      environmentId,
      input: { patch: { daxiang: { approvalMonitor: patch } } },
    });
    setBusy(false);
    setFailed(result._tag !== "Success");
    if (result._tag === "Success") query.refresh();
  };
  const run = async (
    input: { type: "refresh" | "restart" | "clear_records" } | { type: "login"; port: number },
  ) => {
    if (!canMutate || busy) return;
    if (input.type === "login" && !validPort) return;
    setBusy(true);
    setFailed(false);
    const result = await mutate({ environmentId, input });
    setBusy(false);
    setFailed(result._tag !== "Success");
    query.refresh();
  };

  const toggle = (key: keyof MonitorSettings, title: string, subtitle: string) => (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="grid gap-1">
        <Label htmlFor={`approval-${key}-${environmentId}`}>{t(title)}</Label>
        <p className="max-w-prose text-xs text-muted-foreground">{t(subtitle)}</p>
      </div>
      <Switch
        id={`approval-${key}-${environmentId}`}
        checked={Boolean(monitor[key])}
        disabled={!allowed || busy}
        onCheckedChange={(value) => void save({ [key]: value } as MonitorPatch)}
      />
    </div>
  );

  return (
    <section className="grid gap-4 border-t px-4 py-4" aria-label={t("Approval link monitoring")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="text-sm font-medium">{t("Approval link monitoring")}</h3>
          <p className="max-w-prose text-xs text-muted-foreground">
            {t(
              "Listen to DaXiang through dumbo-web. Pull requests and MCM can be approved through their official CLIs; Lion, RDS and DMS remain manual.",
            )}
          </p>
        </div>
        <Switch
          aria-label={t("Enable approval link monitoring")}
          checked={monitor.enabled}
          disabled={!allowed || busy}
          onCheckedChange={(value) => void save({ enabled: value })}
        />
      </div>

      <div className="grid gap-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-sm">
            {state ? t(statusMessages[state.status]) : t("Loading...")}
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!canMutate || busy}
              onClick={() => void run({ type: "restart" })}
            >
              {t("Restart listener")}
            </Button>
            <Button
              size="xs"
              disabled={!canMutate || busy || !validPort}
              onClick={() => void run({ type: "login", port: portNumber })}
            >
              {t("Import DaXiang login")}
            </Button>
          </div>
        </div>
        {state?.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor={`approval-port-${environmentId}`}>{t("Chrome CDP port")}</Label>
          <Input
            id={`approval-port-${environmentId}`}
            value={port}
            inputMode="numeric"
            disabled={!allowed || busy}
            onChange={(event) =>
              editDraft("port", event.target.value.replace(/\D/gu, "").slice(0, 5))
            }
            onBlur={() => {
              const value = Number(port);
              clearDraft("port");
              if (value >= 1 && value <= 65535 && value !== monitor.chromeCdpPort) {
                void save({ chromeCdpPort: value });
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Open x.sankuai.com in a dedicated Chrome session with this loopback debugging port, finish SSO, then import. Credentials stay on this server.",
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-1">
        {toggle(
          "includeGroupChats",
          "Include group chats",
          "Also process approval links received in groups. Direct messages and approval bot messages are always included.",
        )}
        {toggle(
          "autoApprovePullRequest",
          "Automatically approve pull requests",
          "Check that the PR is open and not authored by you, add yourself as a reviewer when needed, comment, then approve. Never merge.",
        )}
        <div className="grid gap-1.5 py-2 sm:max-w-sm">
          <Label htmlFor={`approval-pr-comment-${environmentId}`}>{t("PR review comment")}</Label>
          <Input
            id={`approval-pr-comment-${environmentId}`}
            value={prComment}
            disabled={!allowed || busy}
            onChange={(event) => editDraft("prComment", event.target.value)}
            onBlur={() => {
              const value = prComment.trim() || "LGTM";
              clearDraft("prComment");
              if (value !== monitor.pullRequestComment) {
                void save({ pullRequestComment: value });
              }
            }}
          />
        </div>
        {toggle(
          "autoApproveMcm",
          "Automatically approve MCM plans and events",
          "Verify the pending approval state and current MCM plan level before approving. This never executes the change itself.",
        )}
        <div className="grid gap-1.5 py-2 sm:max-w-sm">
          <Label htmlFor={`approval-mcm-comment-${environmentId}`}>
            {t("MCM approval comment")}
          </Label>
          <Input
            id={`approval-mcm-comment-${environmentId}`}
            value={mcmComment}
            disabled={!allowed || busy}
            onChange={(event) => editDraft("mcmComment", event.target.value)}
            onBlur={() => {
              const value = mcmComment.trim() || "自动审批通过";
              clearDraft("mcmComment");
              if (value !== monitor.mcmApproveComment) {
                void save({ mcmApproveComment: value });
              }
            }}
          />
        </div>
        {toggle(
          "notifyUnsupportedLinks",
          "Remind me about manual approvals",
          "Show a notification and keep a recent record for Lion, RDS, DMS, or automatic approvals switched off. A DaXiang direct message is also sent when bot credentials and MIS are configured.",
        )}
        {toggle(
          "autoOpenUnsupportedInBrowser",
          "Open manual approvals in the browser",
          "Open Lion, RDS, DMS, or other manual approval links on this server for one-click review. No approval button is clicked automatically.",
        )}
        {toggle(
          "replyOnHandled",
          "Reply to the sender",
          "Send a short DaXiang reply after an approval or manual reminder. Replies are not sent for public-account messages.",
        )}
      </div>

      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {t("Could not update the approval listener. Check its settings and try again.")}
        </p>
      ) : null}

      <div className="grid gap-2 border-t pt-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium">{t("Recent approval activity")}</h4>
          <Button
            size="xs"
            variant="ghost"
            disabled={!canMutate || busy || !state?.records.length}
            onClick={() => void run({ type: "clear_records" })}
          >
            {t("Clear")}
          </Button>
        </div>
        {state?.records.length ? (
          <ul className="grid gap-2">
            {state.records.slice(0, 8).map((record) => (
              <li key={record.id} className="grid gap-1 rounded-md border p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium wrap-anywhere">{record.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(outcomeMessages[record.outcome])} ·{" "}
                      {new Date(record.createdAt).toLocaleString()}
                      {record.senderName ? ` · ${record.senderName}` : ""}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void readLocalApi()?.shell.openExternal(record.url)}
                  >
                    {t("Open")}
                  </Button>
                </div>
                {record.detail ? (
                  <p className="text-xs text-muted-foreground wrap-anywhere">{record.detail}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t("No approval activity yet.")}</p>
        )}
      </div>
    </section>
  );
}
