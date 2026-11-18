import { useUiTranslation } from "../../hooks/useUiTranslation";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ChevronDownIcon, SettingsIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { isMeituanServiceEnabled } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect, useState, type ReactNode } from "react";
import type {
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  SourceControlTool,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@t3tools/contracts";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { GitIcon, JujutsuIcon, type Icon } from "../Icons";
import { MeituanCodeAuthorizationObserver } from "./MeituanCodeSettings";
import { IssueTrackerSettings } from "./IssueTrackerSettings";
import { SourceControlHostSettings } from "./SourceControlHostSettings";
import { SourceControlAccountSettings } from "./SourceControlAccountSettings";
import { SourceControlAppSignInSettings } from "./SourceControlAppSignInSettings";
import { SourceControlTokenSettings } from "./SourceControlTokenSettings";
import { SourceControlToolControls, SourceControlToolStatus } from "./SourceControlToolControls";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  SettingsPageContainer,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting, sourceControlHostSettingsSearchId } from "./settingsSearch";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { isSourceControlProviderOffered } from "@t3tools/client-runtime/operations/projects";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { sourceControlIcon } from "~/sourceControlPresentation";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function RedactedAccount(props: { readonly account: string | null }) {
  const t = useUiTranslation();
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel={t("Toggle source control account visibility")}
      revealTooltip={t("Click to reveal account")}
      hideTooltip={t("Click to hide account")}
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (isProviderDiscoveryItem(item)) {
    return item.status === "available" && item.auth.status === "authenticated"
      ? "bg-success"
      : "bg-muted-foreground/35";
  }
  if (item.status !== "available") return "bg-warning";
  return "bg-success";
}

function sourceControlItemIcon(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): ReactNode {
  const host = isProviderDiscoveryItem(item) ? sourceControlClients.find(item.kind) : undefined;
  const Icon = isProviderDiscoveryItem(item)
    ? host && sourceControlIcon(host)
    : VCS_ICONS[item.kind];
  return Icon ? <Icon className="size-4.5 text-foreground/80" aria-hidden /> : null;
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const icon = sourceControlItemIcon(item);

  if (!icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      {icon}
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          dotClassName,
        )}
        aria-hidden
      />
    </span>
  );
}

function ItemSummary({
  item,
  auth,
  authAccount,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  const t = useUiTranslation();
  if (isVcsNotReady(item)) {
    return null;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      return (
        <>
          <span>{t(authAccount ? "Authenticated as" : "Authenticated")}</span>
          {authAccount ? (
            <>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
        </>
      );
    }

    if (auth.status === "unauthenticated" && auth.accounts?.some((entry) => entry.authenticated)) {
      return (
        <span>
          {optionLabel(auth.detail) ?? t("Every {name} host is turned off.", { name: item.label })}
        </span>
      );
    }

    if (auth.status === "unauthenticated") {
      return <span>{t("Not authenticated")}</span>;
    }
    const authDetail = optionLabel(auth.detail);
    return (
      <span>
        {t("Could not verify {name}.", { name: item.label })} {authDetail ?? item.installHint}
      </span>
    );
  }

  return <span>{t(item.status === "available" ? "Installed" : "Not installed")}</span>;
}

function DiscoveryItemRow({
  item,
  offered,
  tool,
  action,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly tool?: SourceControlTool;
  readonly action?: ReactNode;
  readonly offered?: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly onChange: (checked: boolean) => void;
  };
  readonly children?: ReactNode;
}) {
  const t = useUiTranslation();
  const version = tool ? tool.version : optionLabel(item.version);
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetails = children !== undefined;
  const searchTargetId = useSettingsSearchTargetId();
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  const targetsThisRow = searchTargetId === sourceControlHostSettingsSearchId(item.kind);
  if (targetsThisRow && !isExpanded && seenSearchTargetId !== searchTargetId) {
    setIsExpanded(true);
  }
  if (seenSearchTargetId !== searchTargetId) setSeenSearchTargetId(searchTargetId);

  return (
    <div
      className={cn(
        "first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20",
        isVcsNotReady(item) && "opacity-80",
      )}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
              {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
              {isVcsNotReady(item) ? (
                <Badge variant="warning" size="sm">
                  {t("Coming Soon")}
                </Badge>
              ) : null}
              {tool && tool.status !== "installed" ? (
                <Badge variant="secondary" size="sm">
                  {t(tool.status === "unknown" ? "Inspection failed." : "Not installed")}
                </Badge>
              ) : null}
            </div>
            {auth || !tool ? (
              <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-normal text-muted-foreground/80">
                <ItemSummary item={item} auth={auth} authAccount={authAccount} />
              </p>
            ) : null}
            {tool ? <SourceControlToolStatus tool={tool} /> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            {action}
            {hasDetails ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      onClick={() => setIsExpanded((open) => !open)}
                      aria-expanded={isExpanded}
                      aria-label={t("Toggle {name} details", { name: item.label })}
                    >
                      <ChevronDownIcon
                        className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
                      />
                    </Button>
                  }
                />
                <TooltipPopup>{t("Toggle {name} details", { name: item.label })}</TooltipPopup>
              </Tooltip>
            ) : null}
            {offered ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Switch
                      checked={offered.checked}
                      disabled={offered.disabled}
                      onCheckedChange={offered.onChange}
                      aria-label={t(
                        item.kind === "meituan"
                          ? "Enable {name}"
                          : "Offer {name} when adding or publishing a project",
                        {
                          name: item.label,
                        },
                      )}
                    />
                  }
                />
                <TooltipPopup side="top">
                  {item.kind === "meituan"
                    ? t("Enable {name}", { name: item.label })
                    : t("Offer when adding or publishing a project")}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>

      {hasDetails ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleContent>
            <div className="px-3 pb-4 pt-1 sm:px-4">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function SourceControlSectionSkeleton({
  title,
  headerAction,
}: {
  readonly title: string;
  readonly headerAction?: ReactNode;
}) {
  return (
    <SettingsSection title={title} headerAction={headerAction}>
      {SOURCE_CONTROL_SKELETON_ROWS.map((row) => (
        <div key={row} className="first:rounded-t-xl last:rounded-b-xl px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <Skeleton className="size-4.5" />
                  <Skeleton
                    shape="pill"
                    className="pointer-events-none absolute -left-0.5 -top-0.5 size-2"
                    aria-hidden
                  />
                </span>
                <Skeleton shape="pill" className="h-4 w-28" />
                <Skeleton shape="pill" className="h-5 w-14" />
              </div>
              <Skeleton shape="pill" className="h-3 w-full max-w-xs" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Skeleton className="size-7" />
              <Skeleton shape="pill" className="h-5 w-9" />
            </div>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}

function EmptySourceControlDiscovery({
  error,
  isPending,
  onScan,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onScan: () => void;
}) {
  const t = useUiTranslation();
  const hasError = error !== null;

  return (
    <SettingsSection id={searchableSetting("source-control").id} title={t("Server environment")}>
      <Empty>
        <EmptyMedia variant="icon">
          <PullRequestGlyph.pullRequest />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            {hasError ? t("Could not scan the server environment") : t("Nothing detected yet")}
          </EmptyTitle>
          <EmptyDescription>
            {hasError
              ? error
              : t(
                  "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan.",
                )}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onScan} disabled={isPending}>
            <RefreshIcon size="sm" refreshing={isPending} />
            {t("Scan")}
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel({
  integrationsOnly = false,
  children,
}: {
  integrationsOnly?: boolean;
  children?: ReactNode;
}) {
  const t = useUiTranslation();
  const navigate = useNavigate();
  const { scope, environment, connectedEnvironments } = useSettingsScope();

  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const environmentSuffix = aggregate && environment ? ` · ${environment.label}` : "";
  const maintenanceAvailable =
    environmentId !== null &&
    environment?.serverConfig?.environment.capabilities.sourceControlToolMaintenance === true;
  const tools = useEnvironmentQuery(
    maintenanceAvailable ? sourceControlEnvironment.tools({ environmentId, input: {} }) : null,
  );
  const refreshTools = useAtomCommand(sourceControlEnvironment.refreshTools);
  const toolsBusy =
    tools.data?.tools.some((tool) => tool.phase === "running" || tool.phase === "verifying") ??
    false;
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const discovered = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const refreshDiscovery = discovery.refresh;
  const completedTools =
    tools.data?.tools
      .filter((tool) => ["succeeded", "unchanged", "failed"].includes(tool.phase))
      .map((tool) => `${tool.id}:${tool.phase}:${tool.version}`)
      .join(",") ?? "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installer events invalidate the server's separate tool and authentication discovery query
  useEffect(() => {
    if (completedTools) refreshDiscovery();
  }, [completedTools, refreshDiscovery]);
  const maintenanceProps = (kind: string) => {
    const tool = tools.data?.tools.find((entry) => entry.id === kind);
    return tool && environmentId !== null
      ? {
          tool,
          action: (
            <SourceControlToolControls
              key={`${environmentId}:${kind}`}
              tool={tool}
              environmentId={environmentId}
              environmentLabel={environment?.label ?? environmentId}
              busy={toolsBusy}
            />
          ),
        }
      : {};
  };
  const result = {
    ...discovered,
    sourceControlProviders: discovered.sourceControlProviders.filter(
      (item) =>
        sourceControlClients.definitions.some((definition) => definition.kind === item.kind) &&
        (item.kind !== "meituan" ||
          isMeituanServiceEnabled(environment?.serverConfig?.settings, "sourceControl")) &&
        (!integrationsOnly || item.kind === "github" || item.kind === "meituan"),
    ),
  };
  const hasVersionControlSystems = result.versionControlSystems.length > 0;
  const hasDiscoveryItems = hasVersionControlSystems || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    discovery.refresh();
    if (maintenanceAvailable) void refreshTools({ environmentId, input: {} });
  };
  // A CLI login on the server host changes nothing the client reads, so returning to the window
  // asks again. Discovery runs every hosting CLI, too costly for a timer nobody asked for.
  useLiveRefresh(
    () => {
      if (!discovery.isPending) discovery.refresh();
    },
    {
      enabled: environmentId !== null,
      key: `source-control-discovery:${environmentId}`,
      intervalMs: null,
    },
  );
  const offeredProviders = environment?.serverConfig?.settings.offeredSourceControlProviders;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save source control providers",
  });
  const canUpdateSettings = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
  const hostSettingsPanel = (item: SourceControlProviderDiscoveryItem) => {
    const definition = sourceControlClients.find(item.kind);
    if (!definition?.settings || environmentId === null) return undefined;
    if (item.kind === "meituan")
      return (
        <SettingsSearchTarget id={sourceControlHostSettingsSearchId(item.kind)}>
          <Button
            variant="outline"
            onClick={() => void navigate({ to: "/settings/meituan", search: { section: "code" } })}
          >
            <SettingsIcon />
            {t("Meituan integration")}
          </Button>
        </SettingsSearchTarget>
      );
    const { credentials } = definition;
    if (credentials) {
      return (
        <SettingsSearchTarget id={sourceControlHostSettingsSearchId(item.kind)}>
          <div className="grid gap-6">
            {credentials.appSignIn && item.appSignIn === true ? (
              <SourceControlAppSignInSettings
                key={`sign-in-${environmentId}`}
                environmentId={environmentId}
                definition={definition}
                appSignIn={credentials.appSignIn}
                account={Option.getOrNull(item.auth.account)}
                onChanged={handleScan}
              />
            ) : null}
            {credentials.appSignIn && item.appSignIn === true ? (
              <div className="flex items-center gap-3 text-2xs text-muted-foreground">
                <span aria-hidden className="h-px flex-1 bg-border" />
                {t("Or use your own credentials")}
                <span aria-hidden className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            <SourceControlTokenSettings
              key={`token-${environmentId}`}
              environmentId={environmentId}
              definition={definition}
              credentials={credentials}
              onSaved={handleScan}
            />
            {item.status === "available" ? (
              <SourceControlAccountSettings
                key={environmentId}
                environmentId={environmentId}
                definition={definition}
                credentials={credentials}
                auth={item.auth}
                onSaved={handleScan}
              />
            ) : null}
          </div>
        </SettingsSearchTarget>
      );
    }
    return (
      <SettingsSearchTarget id={sourceControlHostSettingsSearchId(item.kind)}>
        <SourceControlHostSettings
          key={environmentId}
          environmentId={environmentId}
          definition={{ ...definition, settings: definition.settings }}
          onSaved={handleScan}
        />
      </SettingsSearchTarget>
    );
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label={t("Rescan server environment")}
          >
            <RefreshIcon refreshing={discovery.isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">{t("Rescan Git and hosting integrations")}</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      {children}
      {tools.error || tools.data?.retrying ? (
        <p role="alert" className="text-sm text-destructive">
          {tools.error ? t(tools.error) : t("Tool status unavailable. Retrying…")}
        </p>
      ) : null}
      {environmentId !== null ? (
        <MeituanCodeAuthorizationObserver
          environmentId={environmentId}
          pending={result.sourceControlProviders.some(
            (item) => item.kind === "meituan" && item.authorization?.status === "pending",
          )}
          onChanged={handleScan}
        />
      ) : null}
      {!integrationsOnly ? <ProjectDefaultsSettings category="source-control" /> : null}
      {environmentId === null ? (
        <SettingsSection
          id={searchableSetting("source-control").id}
          title={t("Server environment")}
        >
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {t(
              "Connect an environment to inspect its version control tools and hosting integrations.",
            )}
          </p>
        </SettingsSection>
      ) : isInitialScanPending ? (
        <>
          <SourceControlSectionSkeleton
            title={`${t("Version Control")}${environmentSuffix}`}
            headerAction={scanButton}
          />
          <SourceControlSectionSkeleton title={t("Source control providers")} />
        </>
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems && !integrationsOnly ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title={`${t("Version Control")}${environmentSuffix}`}
              headerAction={scanButton}
            >
              {result.versionControlSystems.map((item) => (
                <DiscoveryItemRow
                  key={`vcs:${item.kind}`}
                  item={item}
                  {...maintenanceProps(item.kind)}
                />
              ))}
            </SettingsSection>
          ) : null}

          {result.sourceControlProviders.length > 0 ? (
            <SettingsSection
              id={hasVersionControlSystems ? undefined : searchableSetting("source-control").id}
              title={
                hasVersionControlSystems
                  ? t("Source control providers")
                  : `${t("Source control providers")}${environmentSuffix}`
              }
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow
                  key={`provider:${item.kind}`}
                  item={item}
                  {...maintenanceProps(item.kind)}
                  offered={{
                    checked:
                      item.kind === "meituan"
                        ? isMeituanServiceEnabled(
                            environment?.serverConfig?.settings,
                            "sourceControl",
                          )
                        : isSourceControlProviderOffered(offeredProviders, item.kind),
                    disabled:
                      !canUpdateSettings ||
                      (item.kind === "meituan" &&
                        environment?.serverConfig?.environment.capabilities.meituanIntegration !==
                          true),
                    onChange: (checked) =>
                      void updateSettings({
                        environmentId,
                        input: {
                          patch:
                            item.kind === "meituan"
                              ? { meituanSourceControlEnabled: checked }
                              : { offeredSourceControlProviders: { [item.kind]: checked } },
                        },
                      }),
                  }}
                >
                  {hostSettingsPanel(item)}
                </DiscoveryItemRow>
              ))}
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <EmptySourceControlDiscovery
          error={discovery.error}
          isPending={discovery.isPending}
          onScan={handleScan}
        />
      )}
      {environmentId === null || integrationsOnly ? null : (
        <IssueTrackerSettings key={environmentId} environmentId={environmentId} />
      )}

      {!integrationsOnly ? <SourceControlWritingSettingsSection /> : null}
    </SettingsPageContainer>
  );
}
