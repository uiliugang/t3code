import { ArrowRightIcon, CircleHelpIcon } from "lucide-react";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function ProviderConnectionHelp({ codex }: { readonly codex: boolean }) {
  const t = useUiTranslation();
  const methods = codex
    ? [
        {
          name: "ChatGPT account",
          route: ["T3", "Codex", "OpenAI"],
          detail: t(
            "T3 manages your ChatGPT sign-in. Requests use your account's Codex allowance.",
          ),
        },
        {
          name: "Use existing CLI",
          route: ["T3", "Configured Codex CLI", "Configured service"],
          detail: t(
            "Uses the login and configuration in your Codex home. This can be a ChatGPT account or an API service.",
          ),
        },
        {
          name: "API Key",
          route: ["T3", "Codex", "API base URL"],
          detail: t(
            "Uses this connection's saved URL and key. The service must support the Responses API and bills its usage.",
          ),
        },
      ]
    : [
        {
          name: "Claude account / existing CLI",
          route: ["T3", "Claude Code", "Configured service"],
          detail: t(
            "Uses your existing Claude Code login and configuration. Sign in through the CLI on this environment.",
          ),
        },
        {
          name: "API Key",
          route: ["T3", "Claude Code", "API base URL"],
          detail: t(
            "Uses this connection's saved URL, key and protocol. Supports Anthropic Messages and OpenAI Chat Completions.",
          ),
        },
      ];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={t("How connection methods work")}
          />
        }
      >
        <CircleHelpIcon />
      </PopoverTrigger>
      <PopoverPopup width="lg" align="start" touchBackdrop>
        <div className="space-y-4 text-xs">
          <h3 className="text-sm font-semibold">{t("How connection methods work")}</h3>
          {methods.map((method) => (
            <div key={method.name} className="space-y-2">
              <h4 className="font-medium">{t(method.name)}</h4>
              <ol className="flex flex-wrap items-center gap-1.5" aria-label={t("Request path")}>
                {method.route.map((node, index) => (
                  <li key={node} className="flex items-center gap-1.5">
                    {index > 0 ? (
                      <ArrowRightIcon className="size-3 text-muted-foreground" aria-hidden />
                    ) : null}
                    <span className="rounded-md bg-muted px-2 py-1">{t(node)}</span>
                  </li>
                ))}
              </ol>
              <p className="leading-relaxed text-muted-foreground">{method.detail}</p>
            </div>
          ))}
          <p className="border-t border-border pt-3 leading-relaxed text-muted-foreground">
            {t(
              "Each connection keeps its own configuration and credentials. Switching back restores what you saved.",
            )}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
