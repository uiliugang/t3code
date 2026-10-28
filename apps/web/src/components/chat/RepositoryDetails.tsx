import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import type {
  EnvironmentId,
  ThreadId,
  ThreadWorkspaceRevision,
  WorkspaceExecutionResource,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, FolderGit2Icon } from "lucide-react";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import GitActionsControl from "../GitActionsControl";
import { useUiTranslation } from "../../hooks/useUiTranslation";

export function RepositoryDetails({
  environmentId,
  threadId,
  workspace,
  resource,
  expanded,
  onToggle,
  onOpenChanges,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspace: ThreadWorkspaceRevision;
  resource: WorkspaceExecutionResource;
  expanded: boolean;
  onToggle: () => void;
  onOpenChanges: () => void;
}) {
  const t = useUiTranslation();
  const terminals = useThreadTerminalActions({ environmentId, threadId });
  const target = { threadId, workspaceRevisionId: workspace.id, resourceId: resource.id };
  const status = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: resource.checkoutRoot } }),
  );
  const totals = status.data?.branchChanges ?? status.data?.workingTree;
  const roots = workspace.bindings.filter((binding) => binding.resourceId === resource.id);
  const name = roots.map((binding) => binding.alias).join(" / ");
  return (
    <section aria-label={name} className="min-w-0 border-t border-border/50">
      <button
        type="button"
        className="flex w-full min-w-0 flex-col gap-1 px-4 py-3 text-left hover:bg-accent/40"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-sm font-medium">
          <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
              {name}
            </TooltipTrigger>
            <TooltipPopup>{resource.checkoutRoot}</TooltipPopup>
          </Tooltip>
          {roots.some((binding) => binding.rootId === workspace.primaryRootId) ? (
            <Badge variant="secondary" size="sm">
              {t("Primary repository")}
            </Badge>
          ) : null}
          {expanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0" />
          )}
        </span>
        {!expanded ? (
          <span className="flex w-full min-w-0 items-center gap-2 pl-6 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {status.error
                ? t("Status unavailable")
                : status.data
                  ? (status.data.refName ?? t("Detached HEAD"))
                  : t("Loading...")}
            </span>
            {totals && !status.error ? (
              <span className="shrink-0 tabular-nums">
                <span className="text-success">+{totals.insertions}</span>{" "}
                <span className="text-destructive">−{totals.deletions}</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div data-workspace-repository-content className="flex min-w-0 flex-col pb-2">
          <BranchToolbarBranchSelector
            repository={{ target, cwd: resource.checkoutRoot }}
            environmentId={environmentId}
            threadId={threadId}
            displayMode="panel"
            envLocked
            effectiveEnvModeOverride="worktree"
            startFromOrigin={false}
            onStartFromOriginChange={() => {}}
          />
          <div className="px-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={!terminals.canWrite()}
              onClick={() => {
                const launched = terminals.launchTerminal({
                  location: {
                    cwd: resource.checkoutRoot,
                    worktreePath: resource.ownership === "managed" ? resource.checkoutRoot : null,
                  },
                  place: (terminalId) =>
                    useRightPanelStore
                      .getState()
                      .openTerminal({ environmentId, threadId }, terminalId),
                });
                if (launched) void launched.result;
              }}
            >
              {t("Open terminal")}
            </Button>
          </div>
          <GitActionsControl
            key={`${workspace.id}:${resource.id}`}
            gitCwd={resource.checkoutRoot}
            activeThreadRef={{ environmentId, threadId }}
            repositoryTarget={target}
            onOpenChanges={onOpenChanges}
          />
        </div>
      ) : null}
    </section>
  );
}
