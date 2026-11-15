// @effect-diagnostics globalFetch:off - browser.evaluate configures the isolated scenario server.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "creating an issue opens a side chat without leaving the conversation",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("issue-side-chat");
    const thread = await t3.thread({
      project,
      title: "Keep the source conversation",
      model: "multi-turn",
      messages: ["Prepare an issue from this conversation."],
    });
    await t3.open(thread);
    await expect(screen.getByRole("button", "Toggle thread details panel")).toBeVisible();
    await browser.evaluate(async (workspaceRoot: string) => {
      const [{ projects }, { environmentId }] = await Promise.all([
        fetch("/api/projects").then((response) => response.json()) as Promise<{
          projects: Array<{ id: string; workspaceRoot: string }>;
        }>,
        fetch("/.well-known/t3/environment").then((response) => response.json()) as Promise<{
          environmentId: string;
        }>,
      ]);
      const project = projects.find((entry) => entry.workspaceRoot === workspaceRoot);
      if (!project) throw new Error("Scenario project is missing");
      const serverModule = "/src/state/server.ts";
      const registryModule = "/src/rpc/atomRegistry.ts";
      const { serverEnvironment } = await import(serverModule);
      const { appAtomRegistry } = await import(registryModule);
      const saved = await serverEnvironment.updateSettings.run(appAtomRegistry, {
        environmentId,
        input: {
          patch: {
            issueProjectSources: {
              [project.id]: [{ provider: "github", host: "github.com", scope: "acme/app" }],
            },
          },
        },
      });
      if (saved._tag !== "Success") throw new Error(`Source fixture failed: ${saved.cause}`);
      return true;
    }, project);
    const sourceUrl = await browser.evaluate<string>("location.href");
    await app.open(sourceUrl);
    const details = screen.getByRole("button", "Toggle thread details panel");
    await expect(details).toBeVisible();
    const detailsOpen = await browser.evaluate<boolean>(
      `document.querySelector('button[aria-label="Toggle thread details panel"]')?.getAttribute("aria-pressed") === "true"`,
    );
    if (!detailsOpen) await details.tap();
    const create = screen.getByRole("button", /^(Create issue|创建需求)$/);
    await expect(create).toBeEnabled();
    await app.screenshot("before-issue-creation");
    await create.tap();
    const sideChat = browser.locator("[data-side-chat-pane]");
    await expect(sideChat).toBeVisible();
    await expect(sideChat).toContainText("first fixture turn complete");
    await expect(browser).toHaveURL(sourceUrl);
    await app.screenshot("issue-creation-side-chat");
  },
);
