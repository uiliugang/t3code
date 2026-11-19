import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MaintainableTool } from "@t3tools/contracts";
import { sourceControlToolStatus } from "@t3tools/client-runtime/state/source-control";
import {
  ArrowUpToLineIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  HourglassIcon,
  RotateCcwIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { cn } from "../../lib/utils";
import { formatEnvironmentQueryError } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SourceControlToolStatus({ tool }: { readonly tool: MaintainableTool }) {
  const t = useUiTranslation();
  if (tool.phase === "idle") return null;
  return (
    <p
      role="status"
      className={cn(
        "mt-1 text-xs leading-normal",
        tool.phase === "failed"
          ? "text-destructive"
          : tool.phase === "succeeded"
            ? "text-success"
            : "text-muted-foreground",
      )}
    >
      {sourceControlToolStatus(tool, t)}
    </p>
  );
}

export function SourceControlToolControls({
  tool,
  environmentId,
  environmentLabel,
  busy,
}: {
  readonly tool: MaintainableTool;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly busy: boolean;
}) {
  const t = useUiTranslation();
  const canMaintain = useAtomValue(
    sourceControlEnvironment.startTool.permissionAtom(environmentId),
  );
  const start = useAtomCommand(sourceControlEnvironment.startTool, { reportFailure: false });
  const [selected, setSelected] = useState<MaintainableTool | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: () => setError(t("Could not copy command.")),
  });
  const running = tool.phase === "running" || tool.phase === "verifying";
  const manual = tool.command === null;
  const action = t(
    tool.phase === "failed" ? "Retry {name}" : tool.version ? "Update {name}" : "Install {name}",
    { name: tool.label },
  );
  const label = running
    ? sourceControlToolStatus(tool, t)
    : manual
      ? t("Manage {name} on the server", { name: tool.label })
      : action;
  const Icon = running
    ? HourglassIcon
    : manual
      ? WrenchIcon
      : tool.phase === "failed"
        ? RotateCcwIcon
        : tool.version
          ? ArrowUpToLineIcon
          : DownloadIcon;
  const command = selected?.command ?? selected?.manualCommand;
  const confirm = async () => {
    if (
      !selected?.command ||
      pending ||
      selected.id === "ones2" ||
      selected.id === "mcm" ||
      selected.id === "mtskills"
    )
      return;
    setPending(true);
    setError(null);
    const result = await start({
      environmentId,
      input: {
        id: selected.id,
        expectedVersion: selected.version,
        expectedPath: selected.executablePath,
        expectedCommand: selected.command,
      },
    });
    setPending(false);
    if (result._tag === "Success") setSelected(null);
    else setError(t(formatEnvironmentQueryError(result.cause)));
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={label}
            disabled={pending || running || (!manual && (busy || !canMaintain))}
            onClick={() => {
              setError(null);
              setSelected(tool);
            }}
          >
            <Icon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipPopup>
          {!manual && !canMaintain
            ? t("Environment maintenance permission required.")
            : busy && !running && !manual
              ? t("Another tool installation is running on this environment.")
              : label}
        </TooltipPopup>
      </Tooltip>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {selected?.command
                ? t(selected.version ? "Update {name}" : "Install {name}", { name: selected.label })
                : t("Manual maintenance")}
            </DialogTitle>
            <DialogDescription>
              {t("Target environment: {name}", { name: environmentLabel })}
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-4 px-6 pb-5 text-sm">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">{t("Current version")}</dt>
              <dd className="break-all font-mono text-xs">
                {selected?.version ??
                  t(selected?.status === "missing" ? "Not installed" : "Unknown")}
              </dd>
              <dt className="text-muted-foreground">{t("Executable path")}</dt>
              <dd className="break-all font-mono text-xs">
                {selected?.executablePath ??
                  t(selected?.status === "missing" ? "Not installed" : "Unknown")}
              </dd>
            </dl>
            {selected?.reason ? (
              <p className="text-muted-foreground">{t(selected.reason)}</p>
            ) : null}
            {command ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {t(selected?.command ? "Installation command" : "Server command")}
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label={t(isCopied ? "Copied" : "Copy command")}
                          onClick={() => copyToClipboard(command)}
                        >
                          {isCopied ? <CheckIcon /> : <CopyIcon />}
                        </Button>
                      }
                    />
                    <TooltipPopup>{t(isCopied ? "Copied" : "Copy command")}</TooltipPopup>
                  </Tooltip>
                </div>
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-relaxed">
                  <code>{command}</code>
                </pre>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setSelected(null)}>
              {t(selected?.command ? "Cancel" : "Close")}
            </Button>
            {selected?.command ? (
              <Button disabled={pending || busy || !canMaintain} onClick={() => void confirm()}>
                {pending ? (
                  <HourglassIcon />
                ) : selected.version ? (
                  <ArrowUpToLineIcon />
                ) : (
                  <DownloadIcon />
                )}
                {t(pending ? "Starting..." : selected.version ? "Update" : "Install")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
