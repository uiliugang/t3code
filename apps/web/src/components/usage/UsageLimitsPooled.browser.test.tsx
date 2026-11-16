import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { __setClientSettingsForTests } from "../../hooks/useSettings";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });

  it("translates summarized provider notices and expands details without alert live-region wrapper", async () => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "zh-CN" });
    const unauthenticated: ServerProvider = {
      ...managedChatGpt("codex_cli", "Codex"),
      auth: { status: "unauthenticated" },
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: 'Codex CLI is not authenticated. Run `codex login` with CODEX_HOME="/tmp".',
        },
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: { providers: [unauthenticated] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    const toggle = screen.getByRole("button", { name: "Codex: 未认证" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText(/Run `codex login`/)).toBeVisible();
  });
});
