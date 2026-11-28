import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectHumanActions,
  readHumanActionSnapshot,
  verifyPendingHumanAction,
  type ScopedHumanAction,
} from "@t3tools/client-runtime/state/human-action-inbox";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { InboxIcon, MessageCircleQuestionMarkIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { randomUUID } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { readEnvironment, useEnvironments } from "../../state/environments";
import { pendingHumanActionsAtom } from "../../state/orchestration";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

declare module "@tanstack/react-router" {
  interface HistoryState {
    pendingHumanAction?: Omit<ScopedHumanAction, "createdAt"> & { readonly activation: string };
  }
}

const pendingInboxes = environmentAtomList("pending-human-actions", pendingHumanActionsAtom);
type InboxFilter = ScopedHumanAction["kind"] | "all";
const actionKey = (target: ScopedHumanAction) =>
  JSON.stringify([
    target.environmentId,
    target.threadId,
    target.kind,
    target.requestId,
    target.targetItemId,
  ]);

function InboxRow({
  target,
  environmentLabel,
  checking,
  onOpen,
}: {
  readonly target: ScopedHumanAction;
  readonly environmentLabel: string | null;
  readonly checking: boolean;
  readonly onOpen: (target: ScopedHumanAction) => void;
}) {
  const t = useUiTranslation();
  const thread = useQuietThreadShell(scopeThreadRef(target.environmentId, target.threadId));
  const project = useProject(scopeProjectRef(target.environmentId, target.projectId));
  const approval = target.kind === "approval";
  const Icon = approval ? ShieldCheckIcon : MessageCircleQuestionMarkIcon;
  return (
    <li>
      <Button
        variant="ghost"
        size="row"
        disabled={checking}
        aria-busy={checking || undefined}
        onClick={() => void onOpen(target)}
      >
        <span
          aria-hidden
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg",
            approval ? "bg-warning/15 text-warning-foreground" : "bg-info/15 text-info-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{thread?.title ?? t("Thread")}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[project?.title, environmentLabel].filter(Boolean).join(" · ")}
          </span>
        </span>
        {checking ? (
          <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
            <Spinner className="size-3" />
            {t("Checking…")}
          </span>
        ) : (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 text-2xs font-semibold",
              approval
                ? "bg-warning/15 text-warning-foreground"
                : "bg-info/15 text-info-foreground",
            )}
          >
            {approval ? t("Approvals") : t("Questions")}
          </span>
        )}
      </Button>
    </li>
  );
}

export function SidebarHumanActionInbox() {
  const t = useUiTranslation();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { environments } = useEnvironments();
  const canRead = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const canOperate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const [open, setOpen] = useState(false);
  const navigated = useRef(false);
  const checking = useRef<AbortController | null>(null);
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the outstanding verification transport when this inbox unmounts
  useEffect(() => () => checking.current?.abort(), []);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const supported = environments.filter(
    ({ environmentId, serverConfig }) =>
      canRead.has(environmentId) &&
      canOperate.has(environmentId) &&
      serverConfig?.environment.capabilities.pendingHumanActions === true,
  );
  const connected = supported.filter(({ connection }) => connection.phase === "connected");
  // The entry shows a live count, so the snapshots stay subscribed while the dialog is closed.
  // Each stream sends one snapshot and then only updates when a request changes.
  const results = useAtomValue(
    pendingInboxes(environmentIdsKey(connected.map(({ environmentId }) => environmentId))),
  );
  const ready = connected.flatMap(({ environmentId }, index) => {
    const snapshot = readHumanActionSnapshot(results[index]);
    return snapshot ? [{ environmentId, targets: snapshot.targets }] : [];
  });
  const incomplete = ready.length < environments.length;
  const actions = collectHumanActions(ready);
  const counts = {
    all: actions.length,
    approval: actions.filter((target) => target.kind === "approval").length,
    user_input: actions.filter((target) => target.kind === "user_input").length,
  };
  const visible = filter === "all" ? actions : actions.filter((target) => target.kind === filter);
  const multiEnvironment = environments.length > 1;
  if (supported.length === 0 && !open) return null;

  const onOpen = async (target: ScopedHumanAction) => {
    const { environmentId, threadId } = target;
    const canVerify = () => {
      const environment = readEnvironment(environmentId);
      return (
        environment?.connection.phase === "connected" &&
        readEnvironmentScope(environmentId, AuthOrchestrationReadScope) &&
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) &&
        environment.serverConfig?.environment.capabilities.pendingHumanActions === true
      );
    };
    checking.current?.abort();
    const controller = new AbortController();
    checking.current = controller;
    setCheckingKey(actionKey(target));
    const activation = randomUUID();
    const valid =
      canVerify() &&
      (await verifyPendingHumanAction(
        appAtomRegistry,
        pendingHumanActionsAtom(environmentId, activation),
        target,
        controller.signal,
      ));
    // A superseded or cancelled check leaves its row to whoever aborted it.
    if (controller.signal.aborted) return;
    checking.current = null;
    setCheckingKey(null);
    if (!valid || !canVerify()) {
      toastManager.add({ type: "info", title: t("This request is no longer available.") });
      return;
    }
    navigated.current = true;
    setOpen(false);
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
      state: (state) => ({
        ...state,
        pendingHumanAction: {
          environmentId,
          threadId,
          projectId: target.projectId,
          kind: target.kind,
          requestId: target.requestId,
          targetItemId: target.targetItemId,
          activation: randomUUID(),
        },
      }),
    });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          checking.current?.abort();
          setCheckingKey(null);
        }
        if (next) {
          navigated.current = false;
          setFilter("all");
        }
        setOpen(next);
      }}
    >
      <SidebarMenu className="mb-1">
        <SidebarMenuItem>
          <DialogTrigger render={<SidebarMenuButton />}>
            <span className="relative">
              <InboxIcon aria-hidden />
              {counts.all > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-warning-foreground motion-reduce:animate-none"
                />
              ) : null}
            </span>
            <span>{t("Waiting for me")}</span>
            {counts.all > 0 ? (
              <span
                key={counts.all}
                aria-label={
                  counts.all === 1
                    ? t("{count} request waiting", { count: 1 })
                    : t("{count} requests waiting", { count: counts.all })
                }
                className="ml-auto inline-flex h-5 min-w-5 animate-(--animate-space-pop) items-center justify-center rounded-full bg-warning/15 px-1 text-2xs leading-none font-bold text-warning-foreground motion-reduce:animate-none"
              >
                {counts.all}
              </span>
            ) : null}
          </DialogTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <DialogPopup
        className="flex max-h-[min(36rem,85vh)] flex-col sm:max-w-md"
        finalFocus={() => !navigated.current}
      >
        <div className="flex items-center gap-3 px-6 pt-6 pr-12 pb-4">
          <div>
            <DialogTitle>{t("Waiting for me")}</DialogTitle>
          </div>
          {counts.all > 0 ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-2xs font-semibold text-muted-foreground tabular-nums">
              {counts.all}
            </span>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3">
          {incomplete ? (
            <p
              role="status"
              className="flex items-center gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground"
            >
              <InboxIcon aria-hidden className="size-3.5" />
              {t("Some environments are unavailable. This list may be incomplete.")}
            </p>
          ) : null}
          <ToggleGroup
            aria-label={t("Pending request filters")}
            value={[filter]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "all" || next === "approval" || next === "user_input") setFilter(next);
            }}
          >
            <Toggle value="all">
              {t("All")} {counts.all}
            </Toggle>
            <Toggle value="approval">
              {t("Approvals")} {counts.approval}
            </Toggle>
            <Toggle value="user_input">
              {t("Questions")} {counts.user_input}
            </Toggle>
          </ToggleGroup>
          {visible.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
              <span className="glass-tile grid size-9 place-items-center rounded-xl text-muted-foreground">
                <InboxIcon className="size-4" />
              </span>
              <p className="text-sm font-medium">
                {actions.length > 0
                  ? t("No requests match this filter.")
                  : incomplete
                    ? t("No requests from synchronized environments.")
                    : t("No supported pending approvals or questions.")}
              </p>
            </div>
          ) : (
            <ul className="min-h-0 space-y-1 overflow-y-auto">
              {visible.map((target) => (
                <InboxRow
                  key={actionKey(target)}
                  target={target}
                  environmentLabel={
                    multiEnvironment
                      ? (connected.find(
                          ({ environmentId }) => environmentId === target.environmentId,
                        )?.label ?? null)
                      : null
                  }
                  checking={checkingKey === actionKey(target)}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="border-t px-6 py-4">
          <DialogDescription>
            {t(
              "Shows supported approval and reply requests from directly connected environments. Linked work and other request types stay in their conversations.",
            )}
          </DialogDescription>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
