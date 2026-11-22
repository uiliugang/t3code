import { useAtomValue } from "@effect/atom-react";
import { mepAccountLabel, mepTrackerSummary } from "@t3tools/client-runtime/meituanSettings";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, ClipboardListIcon } from "lucide-react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SourceControlToolControls, SourceControlToolStatus } from "./SourceControlToolControls";
import { SettingsRow } from "./settingsLayout";

export function MepIssueTrackerSettings({
  environmentId,
  label,
  supported,
  projects,
}: {
  environmentId: EnvironmentId;
  label: string;
  supported: boolean;
  projects: string;
}) {
  const t = useUiTranslation();
  const tools = useEnvironmentQuery(
    supported ? sourceControlEnvironment.meituanTools({ environmentId, input: {} }) : null,
  );
  const refresh = useAtomCommand(sourceControlEnvironment.refreshTools);
  const canRefresh = useAtomValue(
    sourceControlEnvironment.refreshTools.permissionAtom(environmentId),
  );
  const available = tools.data?.tools ?? [];
  const ones = available.find((tool) => tool.id === "ones2");
  const busy = available.some((tool) => tool.phase === "running" || tool.phase === "verifying");
  const unavailable =
    tools.error ?? (tools.data?.retrying ? t("Tool status unavailable. Retrying…") : null);
  return (
    <details className="group/mep">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-3 hover:bg-muted/20 focus-visible:outline-ring sm:px-4 [&::-webkit-details-marker]:hidden">
        <ClipboardListIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t("MEP ONES")}</span>
            <span className="text-xs text-muted-foreground">{t("Enabled")}</span>
          </span>
          <span className="mt-1 block text-xs text-muted-foreground wrap-anywhere group-open/mep:hidden">
            {mepTrackerSummary(ones, projects, t)}
          </span>
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground group-open/mep:rotate-180"
        />
      </summary>
      <div className="px-3 pb-3 sm:px-4">
        <SettingsRow
          title={t("ONES account")}
          description={[mepAccountLabel(ones, t), "mep.sankuai.com"].join(" · ")}
          control={
            <Button
              size="sm"
              variant="ghost"
              disabled={!supported || busy}
              onClick={() =>
                canRefresh ? void refresh({ environmentId, input: {} }) : tools.refresh()
              }
            >
              {t("Detect again")}
            </Button>
          }
        />
        {ones?.status === "installed" && ones.account === null ? (
          <p className="text-xs text-muted-foreground">
            {t("Configure ONES in this environment's terminal, then detect again.")}
          </p>
        ) : null}
        {available
          .filter((tool) => tool.id === "ones2" || tool.id === "mcm")
          .map((tool) => (
            <SettingsRow
              key={tool.id}
              title={tool.id === "ones2" ? t("Requirements CLI") : t("Delivery CLI (optional)")}
              description={
                <>
                  <span className="font-mono">{tool.id}</span> ·{" "}
                  {tool.version ?? t(tool.status === "missing" ? "Not installed" : "Unknown")}
                  <SourceControlToolStatus tool={tool} />
                </>
              }
              control={
                <SourceControlToolControls
                  tool={tool}
                  environmentId={environmentId}
                  environmentLabel={label}
                  busy={busy}
                  showLabel
                />
              }
            />
          ))}
        {unavailable || !supported || (tools.isPending && !tools.data) ? (
          <p role="status" className="text-xs text-muted-foreground">
            {unavailable ?? t(supported ? "Loading..." : "Server update required")}
          </p>
        ) : null}
      </div>
    </details>
  );
}
