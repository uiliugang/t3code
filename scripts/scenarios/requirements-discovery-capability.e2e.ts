// @effect-diagnostics globalFetch:off - browser.evaluate configures the isolated scenario client.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Ignoring a candidate requires the destination's discovery capability",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("discovery-capability");
    await t3.thread({
      project,
      title: "Discover this conversation",
      model: "multi-turn",
      messages: ["Prepare a local task."],
    });
    await t3.open("/requirements");
    await screen.getByRole("button", /^(Scan chats|扫描会话)/).tap();
    await screen.getByRole("menuitem").first().tap();
    await screen.getByRole("menuitem", "discovery-capability").tap();
    const ignore = screen.getByRole("button", /^(Ignore|忽略)$/);
    await expect(ignore).toBeVisible();
    await browser.evaluate(async () => {
      const { environmentId } = await fetch("/.well-known/t3/environment").then((response) =>
        response.json(),
      );
      const serverModule = "/src/state/server.ts";
      const registryModule = "/src/rpc/atomRegistry.ts";
      const { serverEnvironment } = await import(serverModule);
      const { appAtomRegistry } = await import(registryModule);
      // Retained candidates can outlive the server version that advertised discovery.
      const config = serverEnvironment.configValueAtom(environmentId);
      appAtomRegistry.ensureNode(config).setInitialValue({
        ...appAtomRegistry.get(config),
        workItemDiscovery: false,
      });
      return true;
    });
    await app.screenshot("discovery-unavailable");
    await expect(ignore).toBeDisabled();
  },
);
