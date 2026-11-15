import {
  AuthProvidersManageScope,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";

import { useEnvironmentProviders, useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { RefreshIcon } from "./ui/refresh-icon";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  getProviderUpdateRunToastView,
  type ProviderUpdateRun,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// `refreshModels` always drops the server's hour-long latest-version cache. `modelCatalogOnly`
// drops it only when the model manifest changed.
export function useCheckProviderUpdates(environmentIds?: readonly EnvironmentId[]) {
  const { environments } = useEnvironments();
  const selectedEnvironments = environments.filter(
    (environment) =>
      environmentIds === undefined || environmentIds.includes(environment.environmentId),
  );
  const manageableIds = useEnvironmentsWithScope(selectedEnvironments, AuthProvidersManageScope);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const inFlight = useRef<Promise<void> | null>(null);

  const check = async (quiet: boolean, reloadSecrets?: boolean) => {
    const failures = await Promise.all(
      selectedEnvironments
        .filter(
          (environment) =>
            environment.connection.phase === "connected" &&
            manageableIds.has(environment.environmentId),
        )
        .map(async ({ environmentId, label }) => {
          const result = await refreshProviders({
            environmentId,
            input: { refreshModels: true, ...(reloadSecrets ? { reloadSecrets } : {}) },
          });
          if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return [];
          const error = squashAtomCommandFailure(result);
          return [`${label}: ${error instanceof Error ? error.message : "Refresh failed."}`];
        }),
    );
    const lines = failures.flat();
    if (quiet || lines.length === 0) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not check provider updates",
        description: <span className="whitespace-pre-line">{lines.join("\n")}</span>,
      }),
    );
  };

  // A repeat click must not start a second model rediscovery while one is running.
  return ({
    quiet = false,
    reloadSecrets,
  }: { readonly quiet?: boolean; readonly reloadSecrets?: boolean } = {}) => {
    if (inFlight.current) return inFlight.current;
    const running = check(quiet, reloadSecrets).finally(() => {
      inFlight.current = null;
    });
    inFlight.current = running;
    return running;
  };
}

export function useProviderUpdates(environmentIds?: readonly EnvironmentId[]) {
  const { environments } = useEnvironments();
  const selectedEnvironments = environments.filter(
    (environment) =>
      environmentIds === undefined || environmentIds.includes(environment.environmentId),
  );
  const manageableIds = useEnvironmentsWithScope(selectedEnvironments, AuthProvidersManageScope);
  const providersByEnvironment = useEnvironmentProviders();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const machines = selectedEnvironments.flatMap((environment) => {
    const providers = providersByEnvironment.get(environment.environmentId) ?? [];
    if (
      environment.connection.phase !== "connected" ||
      !manageableIds.has(environment.environmentId)
    ) {
      return [];
    }
    const candidates = collectProviderUpdateCandidates(providers).filter((candidate) =>
      canOneClickUpdateProviderCandidate(candidate, providers),
    );
    return candidates.length > 0
      ? [{ environmentId: environment.environmentId, label: environment.label, candidates }]
      : [];
  });

  const updateAll = async ({ quiet = false }: { readonly quiet?: boolean } = {}) => {
    const runs = await Promise.all(
      machines.flatMap(({ environmentId, label, candidates }) =>
        candidates.map(async (candidate): Promise<ProviderUpdateRun> => ({
          environmentId,
          machineLabel: label,
          driver: candidate.driver,
          instanceId: candidate.instanceId,
          result: await updateProvider({
            environmentId,
            input: { provider: candidate.driver, instanceId: candidate.instanceId },
          }),
        })),
      ),
    );
    const view = quiet ? null : getProviderUpdateRunToastView(runs);
    if (view) {
      toastManager.add(
        stackedThreadToast({
          ...view,
          description: <span className="whitespace-pre-line">{view.description}</span>,
        }),
      );
    }
    return runs;
  };

  return { machines, updateAll };
}

export function ProviderUpdatesAction({
  environmentIds,
  allEnvironments = false,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly allEnvironments?: boolean;
}) {
  const t = useUiTranslation();
  const { machines, updateAll } = useProviderUpdates(environmentIds);
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  if (machines.length === 0 && !isPending) {
    return null;
  }

  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    await settlePromise(() => updateAll());
    pending.current = false;
    setIsPending(false);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={isPending}
            onClick={() => void handleUpdate()}
          >
            {isPending
              ? t("Updating…")
              : t(allEnvironments ? "Update all environments" : "Update providers")}
          </Button>
        }
      />
      <TooltipPopup side="top">
        {machines.map((machine) => (
          <div key={machine.environmentId}>
            {machine.label}:{" "}
            {machine.candidates
              .map((candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver)
              .join(", ")}
          </div>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ProviderEnvironmentActions({
  environmentIds,
}: {
  readonly environmentIds: readonly EnvironmentId[];
}) {
  const t = useUiTranslation();
  const { environments } = useEnvironments();
  const manageableIds = useEnvironmentsWithScope(environments, AuthProvidersManageScope);
  const canCheck = environments.some(
    (environment) =>
      environmentIds.includes(environment.environmentId) &&
      environment.connection.phase === "connected" &&
      manageableIds.has(environment.environmentId),
  );
  const check = useCheckProviderUpdates(environmentIds);
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const handleCheck = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    await settlePromise(() => check({ reloadSecrets: true }));
    pending.current = false;
    setIsPending(false);
  };
  return (
    <div className="-me-2 flex min-w-0 flex-col items-end gap-1 @min-[40rem]/providers:flex-row @min-[40rem]/providers:items-center @min-[40rem]/providers:gap-2">
      <ProviderUpdatesAction environmentIds={environmentIds} allEnvironments />
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={isPending || !canCheck}
        aria-busy={isPending}
        onClick={() => void handleCheck()}
      >
        <RefreshIcon refreshing={isPending} />
        {t(isPending ? "Refreshing providers" : "Check all environments")}
      </Button>
    </div>
  );
}
