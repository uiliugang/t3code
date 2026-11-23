import type { DesktopBridge, DesktopCloudSandboxConfig } from "@t3tools/contracts";
import { ChevronRightIcon, CloudIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SshPasswordField } from "./SshPasswordField";

function formatEndpoint(config: Exclude<DesktopCloudSandboxConfig, null>) {
  const hostname = config.hostname.includes(":") ? `[${config.hostname}]` : config.hostname;
  return config.port === 22 ? hostname : `${hostname}:${config.port}`;
}

export function CloudSandboxSettings({
  bridge,
  initiallyOpen,
}: {
  bridge: DesktopBridge;
  initiallyOpen: boolean;
}) {
  const t = useUiTranslation();
  const formId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [config, setConfig] = useState<DesktopCloudSandboxConfig>(null);
  const [host, setHost] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<"load" | "save" | "clear" | "password" | null>(null);
  const [pending, setPending] = useState(true);
  const [saved, setSaved] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this desktop's credential metadata through IPC
  useEffect(() => {
    let current = true;
    void bridge
      .getCloudSandboxConfig()
      .then(
        (result) => {
          if (!current) return;
          setConfig(result);
          setHost(result ? formatEndpoint(result) : "");
        },
        () => {
          if (current) setError("load");
        },
      )
      .finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
    };
  }, [bridge]);

  const save = async () => {
    if (!password && (!config || host.trim().toLowerCase() !== formatEndpoint(config))) {
      setError("password");
      return;
    }
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const result = await bridge.saveCloudSandboxConfig({
        host,
        ...(password ? { password } : {}),
      });
      setConfig(result);
      if (result) setHost(formatEndpoint(result));
      setPassword("");
      setSaved(true);
    } catch {
      setError("save");
    }
    setPending(false);
  };

  const clear = async () => {
    if (
      !(await requestConfirmDialog(t("Clear the saved Cloud Sandbox SSH host and password?"), {
        variant: "destructive",
      }))
    )
      return;
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await bridge.clearCloudSandboxConfig();
      setConfig(null);
      setHost("");
      setPassword("");
    } catch {
      setError("clear");
    }
    setPending(false);
  };

  return (
    <div id="cloud-sandbox" className="border-b">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={formId}
        className="flex min-h-20 w-full items-center gap-3 py-4 text-start hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => {
          setOpen(!open);
          if (open) setPassword("");
        }}
      >
        <CloudIcon className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t("Cloud Sandbox")}</span>
            <span className="mt-1 block text-xs text-muted-foreground wrap-anywhere">
              {config ? formatEndpoint(config) : t("SSH host and password")}
            </span>
          </span>
          <span className="text-xs text-muted-foreground sm:text-end">
            {pending ? t("Loading…") : t(config ? "Configured" : "Not configured")}
          </span>
        </span>
        <ChevronRightIcon
          aria-hidden
          className={
            open
              ? "size-4 shrink-0 rotate-90 text-muted-foreground"
              : "size-4 shrink-0 text-muted-foreground"
          }
        />
      </button>
      {open ? (
        <form
          id={formId}
          className="grid gap-3 border-t pb-4 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) void save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="min-w-0">
              <span className="mb-1.5 block text-xs font-medium">{t("SSH host")}</span>
              <Input
                value={host}
                onChange={(event) => {
                  setHost(event.target.value);
                  setPassword("");
                  setSaved(false);
                }}
                placeholder="sandbox.example.com"
                required
                spellCheck={false}
                disabled={pending}
              />
            </label>
            <SshPasswordField
              value={password}
              onChange={(value) => {
                setPassword(value);
                setSaved(false);
              }}
              placeholder={config ? t("Saved password is hidden") : undefined}
              disabled={pending}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "Default port is 22. For another port, enter host:port. Leave the password blank to keep it for the same host.",
            )}
          </p>
          {error ? (
            <Alert variant="error">
              <AlertDescription>
                {error === "password"
                  ? t("Enter a password for this SSH host.")
                  : error === "load"
                    ? t("Could not read the Cloud Sandbox credential.")
                    : error === "clear"
                      ? t("Could not clear the Cloud Sandbox credential.")
                      : t(
                          "Could not save the Cloud Sandbox credential. Check the host, port, and access to secure credential storage.",
                        )}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {saved ? (
              <span className="text-xs text-muted-foreground" role="status">
                {t("Configuration saved")}
              </span>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || (!config && error !== "load")}
              onClick={() => void clear()}
            >
              {t("Clear configuration")}
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {t("Save configuration")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
