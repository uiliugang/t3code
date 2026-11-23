import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectHumanActions,
  sameHumanAction,
  type ScopedHumanAction,
} from "@t3tools/client-runtime/state/human-action-inbox";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { InboxIcon, MessageCircleIcon, ShieldIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { readEnvironment, useEnvironments } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";

declare module "@tanstack/react-router" {
  interface HistoryState {
    pendingHumanAction?: Omit<ScopedHumanAction, "createdAt"> & { readonly activation: string };
  }
}

const pendingInbox = (environmentId: EnvironmentId) =>
  orchestrationEnvironment.v2.pendingHumanActions({ environmentId, input: {} });
const pendingInboxes = environmentAtomList("pending-human-actions", pendingInbox);

function InboxRow({
  target,
  onOpen,
}: {
  readonly target: ScopedHumanAction;
  readonly onOpen: (target: ScopedHumanAction) => void;
}) {
  const t = useUiTranslation();
  const thread = useQuietThreadShell(scopeThreadRef(target.environmentId, target.threadId));
  const project = useProject(scopeProjectRef(target.environmentId, target.projectId));
  const approval = target.kind === "approval";
  const Icon = approval ? ShieldIcon : MessageCircleIcon;
  return (
    <li>
      <Button
        variant="outline"
        size="multiline"
        className="w-full justify-start text-start"
        onClick={() => onOpen(target)}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">
            {approval ? t("Waiting for approval") : t("Waiting for your answer")}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {[thread?.title ?? t("Thread"), project?.title].filter(Boolean).join(" · ")}
          </span>
        </span>
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
  const [filter, setFilter] = useState<ScopedHumanAction["kind"] | null>(null);
  const supported = environments.filter(
    ({ environmentId, serverConfig }) =>
      canRead.has(environmentId) &&
      canOperate.has(environmentId) &&
      serverConfig?.environment.capabilities.pendingHumanActions === true,
  );
  const connected = supported.filter(({ connection }) => connection.phase === "connected");
  const results = useAtomValue(
    pendingInboxes(
      environmentIdsKey(open ? connected.map(({ environmentId }) => environmentId) : []),
    ),
  );
  const ready = connected.flatMap(({ environmentId }, index) => {
    const result = results[index];
    return result && AsyncResult.isSuccess(result) && !result.waiting && result.value !== null
      ? [{ environmentId, targets: result.value.targets }]
      : [];
  });
  const incomplete = ready.length < environments.length;
  const actions = collectHumanActions(ready);
  const visible = filter === null ? actions : actions.filter((target) => target.kind === filter);
  if (supported.length === 0 && !open) return null;

  const onOpen = (target: ScopedHumanAction) => {
    const { environmentId, threadId } = target;
    const environment = readEnvironment(environmentId);
    const result = appAtomRegistry.get(pendingInbox(environmentId));
    if (
      environment?.connection.phase !== "connected" ||
      !readEnvironmentScope(environmentId, AuthOrchestrationReadScope) ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !AsyncResult.isSuccess(result) ||
      result.waiting ||
      !result.value?.targets.some((candidate) => sameHumanAction(candidate, target))
    ) {
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
        if (next) {
          navigated.current = false;
          setFilter(null);
        }
        setOpen(next);
      }}
    >
      <SidebarMenu className="mb-1">
        <SidebarMenuItem>
          <DialogTrigger render={<SidebarMenuButton />}>
            <InboxIcon aria-hidden />
            <span>{t("Waiting for me")}</span>
          </DialogTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <DialogPopup
        className="flex max-h-[min(36rem,85vh)] flex-col"
        finalFocus={() => !navigated.current}
      >
        <div>
          <DialogTitle>{t("Waiting for me")}</DialogTitle>
          <DialogDescription>
            {t(
              "Shows supported approval and reply requests from directly connected environments. Linked work and other request types stay in their conversations.",
            )}
          </DialogDescription>
        </div>
        {incomplete ? (
          <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t("Some environments are unavailable. This list may be incomplete.")}
          </p>
        ) : null}
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t("Pending request filters")}
        >
          <Button
            size="sm"
            variant={filter === null ? "secondary" : "ghost"}
            aria-pressed={filter === null}
            onClick={() => setFilter(null)}
          >
            {t("All")}
          </Button>
          <Button
            size="sm"
            variant={filter === "approval" ? "secondary" : "ghost"}
            aria-pressed={filter === "approval"}
            onClick={() => setFilter("approval")}
          >
            {t("Approvals")}
          </Button>
          <Button
            size="sm"
            variant={filter === "user_input" ? "secondary" : "ghost"}
            aria-pressed={filter === "user_input"}
            onClick={() => setFilter("user_input")}
          >
            {t("Questions")}
          </Button>
        </div>
        {visible.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            {actions.length > 0
              ? t("No requests match this filter.")
              : incomplete
                ? t("No requests from synchronized environments.")
                : t("No supported pending approvals or questions.")}
          </p>
        ) : (
          <ul className="min-h-0 space-y-1.5 overflow-y-auto">
            {visible.map((target) => (
              <InboxRow
                key={JSON.stringify([
                  target.environmentId,
                  target.threadId,
                  target.kind,
                  target.requestId,
                ])}
                target={target}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
      </DialogPopup>
    </Dialog>
  );
}
