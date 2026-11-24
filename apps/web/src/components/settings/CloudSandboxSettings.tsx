import {
  parseDesktopCloudSandboxEndpoint,
  type DesktopBridge,
  type DesktopCloudSandboxConfig,
} from "@t3tools/contracts";
import { ChevronRightIcon, CloudIcon, PlusIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SshPasswordField } from "./SshPasswordField";

function formatEndpoint(config: DesktopCloudSandboxConfig) {
  const hostname = config.hostname.includes(":") ? `[${config.hostname}]` : config.hostname;
  return config.port === 22 ? hostname : `${hostname}:${config.port}`;
}

export function CloudSandboxSettings({
  bridge,
  initiallyOpen,
}: {
  bridge: Pick<
    DesktopBridge,
    | "getCloudSandboxConfig"
    | "saveCloudSandboxConfig"
    | "clearCloudSandboxConfig"
    | "resetCloudSandboxConfig"
  >;
  initiallyOpen: boolean;
}) {
  const t = useUiTranslation();
  const formId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [configs, setConfigs] = useState<readonly DesktopCloudSandboxConfig[]>([]);
  const [editor, setEditor] = useState<{ previous?: DesktopCloudSandboxConfig } | null>(null);
  const [host, setHost] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<"load" | "save" | "clear" | "reset" | "password" | null>(null);
  const [pending, setPending] = useState(true);
  const [saved, setSaved] = useState(false);
  const cannotRead = error === "load" || error === "reset";
  const endpoint = editor ? parseDesktopCloudSandboxEndpoint(host) : null;
  const retainsPassword =
    endpoint !== null &&
    editor?.previous?.hostname === endpoint.hostname &&
    editor.previous.port === endpoint.port;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this desktop's credential metadata through IPC
  useEffect(() => {
    let current = true;
    void bridge
      .getCloudSandboxConfig()
      .then(
        (result) => {
          if (!current) return;
          setConfigs(result);
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

  const edit = (previous?: DesktopCloudSandboxConfig) => {
    setEditor(previous ? { previous } : {});
    setHost(previous ? formatEndpoint(previous) : "");
    setPassword("");
    setError(null);
    setSaved(false);
  };

  const save = async () => {
    if (!editor) return;
    if (!password && !retainsPassword) {
      setError("password");
      return;
    }
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const result = await bridge.saveCloudSandboxConfig({
        host,
        ...editor,
        ...(password ? { password } : {}),
      });
      setConfigs(result);
      setEditor(null);
      setPassword("");
      setSaved(true);
    } catch {
      setError("save");
    }
    setPending(false);
  };

  const clear = async (target?: DesktopCloudSandboxConfig) => {
    setPending(true);
    try {
      const confirmed = await requestConfirmDialog(
        target
          ? `${t("Remove Cloud Sandbox server?")} ${formatEndpoint(target)}`
          : t(
              "Reset Cloud Sandbox credentials?\nThis removes all saved Cloud Sandbox servers and passwords.",
            ),
        { variant: "destructive" },
      );
      if (confirmed) {
        setSaved(false);
        if (target) {
          setConfigs(await bridge.clearCloudSandboxConfig(target));
        } else {
          await bridge.resetCloudSandboxConfig();
          setConfigs([]);
        }
        setError(null);
      }
    } catch {
      setError(target ? "clear" : "reset");
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
          if (open) {
            setEditor(null);
            setPassword("");
            if (!cannotRead) setError(null);
          }
        }}
      >
        <CloudIcon className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t("Cloud Sandbox")}</span>
            <span className="mt-1 block text-xs text-muted-foreground wrap-anywhere">
              {configs.length === 1 && configs[0] ? formatEndpoint(configs[0]) : t("SSH servers")}
            </span>
          </span>
          <span className="text-xs text-muted-foreground sm:text-end">
            {pending ? t("Loading…") : t(configs.length > 0 ? "Configured" : "Not configured")}
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
        <div id={formId} className="grid gap-3 border-t pb-4 pt-3">
          {configs.length > 0 ? (
            <ul className="divide-y">
              {configs.map((config) => {
                const address = formatEndpoint(config);
                return (
                  <li
                    key={address}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="min-w-0 font-mono text-sm wrap-anywhere">{address}</span>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending || editor !== null}
                        onClick={() => edit(config)}
                      >
                        {t("Edit server")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending || editor !== null}
                        onClick={() => void clear(config)}
                      >
                        {t("Remove server")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {editor ? (
            <form
              className="grid gap-3"
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
                  placeholder={retainsPassword ? t("Saved password is hidden") : undefined}
                  disabled={pending}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Default port is 22. For another port, enter host:port. Leave the password blank to keep it for the same host.",
                )}
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setEditor(null);
                    setPassword("");
                    setError(null);
                  }}
                >
                  {t("Cancel editing")}
                </Button>
                <Button type="submit" size="sm" disabled={pending}>
                  {t("Save configuration")}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {saved ? (
                <span className="text-xs text-muted-foreground" role="status">
                  {t("Configuration saved")}
                </span>
              ) : null}
              {cannotRead ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void clear()}
                >
                  {t("Reset credentials")}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={pending || cannotRead}
                onClick={() => edit()}
              >
                <PlusIcon />
                {t("Add server")}
              </Button>
            </div>
          )}
          {error ? (
            <Alert variant="error">
              <AlertDescription>
                {error === "password"
                  ? t("Enter a password for this SSH host.")
                  : error === "load"
                    ? t("Could not read the Cloud Sandbox credential.")
                    : error === "clear"
                      ? t("Could not clear the Cloud Sandbox credential.")
                      : error === "reset"
                        ? t("Could not reset the Cloud Sandbox credentials.")
                        : t(
                            "Could not save the Cloud Sandbox credential. Check the host, port, and access to secure credential storage.",
                          )}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
