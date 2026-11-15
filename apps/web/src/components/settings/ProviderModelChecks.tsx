import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, LinkIcon, XIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  type ReactNode,
} from "react";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type Result = { success: boolean; message: string; fingerprint: string };
const ModelChecks = createContext<{
  disabled: boolean;
  running: string | null;
  results: Record<string, Result>;
  check: (slug: string) => void;
  cancel: () => void;
} | null>(null);

export function ProviderModelChecks({
  environmentId,
  instanceId,
  disabled,
  fingerprint,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly disabled: boolean;
  readonly fingerprint: string;
  readonly children: ReactNode;
}) {
  const t = useUiTranslation();
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const validate = useAtomCommand(serverEnvironment.validateProviderEndpoint, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    serverEnvironment.validateProviderEndpoint.permissionAtom(environmentId, {
      instanceId,
      check: "model",
    }),
  );
  const check = async (slug: string) => {
    if (disabled || !permitted || running) return;
    setRunning(slug);
    setResults((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => key !== slug)),
    );
    const result = await validate({
      environmentId,
      input: { instanceId, check: "model", model: slug },
    });
    setRunning(null);
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setResults((previous) => ({
      ...previous,
      [slug]: {
        fingerprint,
        success: result._tag === "Success",
        message:
          result._tag === "Success"
            ? result.value.message
            : failure instanceof Error
              ? failure.message
              : "Check failed. Try again.",
      },
    }));
  };
  const cancel = () => {
    void validate({ environmentId, input: { instanceId, check: "cancel" } });
  };
  const cancelOutstanding = useEffectEvent(() => {
    if (running !== null) cancel();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancel the server request when leaving this provider's settings
  useEffect(() => () => cancelOutstanding(), []);
  return (
    <ModelChecks
      value={{
        disabled: disabled || !permitted,
        running,
        results: disabled
          ? {}
          : Object.fromEntries(
              Object.entries(results).filter(([, result]) => result.fingerprint === fingerprint),
            ),
        check,
        cancel,
      }}
    >
      {running !== null ? (
        <div role="status" className="mb-2 flex items-center justify-between gap-2">
          <span className="min-w-0 break-words text-xs text-muted-foreground">
            {t("{model}: Testing model and tools...", { model: running })}
          </span>
          <Button size="sm" variant="outline" onClick={cancel}>
            {t("Cancel check")}
          </Button>
        </div>
      ) : null}
      {children}
    </ModelChecks>
  );
}

export function ProviderModelTestButton({ slug }: { readonly slug: string }) {
  const t = useUiTranslation();
  const checks = useContext(ModelChecks);
  if (!checks) return null;
  const running = checks.running === slug;
  const result = checks.results[slug];
  const label = running ? "Cancel model test" : "Test model & tools";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={t("{action}: {model}", { action: t(label), model: slug })}
            aria-busy={running}
            disabled={!running && (checks.disabled || checks.running !== null)}
            onClick={() => (running ? checks.cancel() : checks.check(slug))}
          />
        }
      >
        {running ? (
          <XIcon />
        ) : result?.success ? (
          <CheckIcon className="text-success" />
        ) : (
          <LinkIcon />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {t(
          running
            ? "Cancel model test"
            : checks.disabled
              ? "Save and enable this connection before testing models."
              : "Test this model and its tools. Sends two requests and uses API credits.",
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ProviderModelTestResult({ slug }: { readonly slug: string }) {
  const t = useUiTranslation();
  const checks = useContext(ModelChecks);
  const result = checks?.results[slug];
  if (checks?.running === slug)
    return (
      <p role="status" className="px-8 py-1.5 text-xs text-muted-foreground">
        {t("Testing model and tools...")}
      </p>
    );
  if (!result) return null;
  const cancelled = result.message === "Check cancelled.";
  return (
    <p
      role="status"
      className={`flex items-start gap-1.5 px-8 py-1.5 text-xs ${cancelled ? "text-muted-foreground" : result.success ? "text-success" : "text-destructive"}`}
    >
      {result.success ? (
        <CheckIcon className="size-3.5 shrink-0" />
      ) : (
        <XIcon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">{t(result.message)}</span>
    </p>
  );
}
