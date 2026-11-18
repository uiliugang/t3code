// @effect-diagnostics globalFetch:off - browser.evaluate configures the isolated scenario server.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "requirements settings shows a project's MEP source",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("mep-source");
    await t3.open("/settings/requirements");
    await expect(screen.getByRole("button", /^(Detect again|重新识别)$/)).toBeVisible();
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
            meituanIntegrationEnabled: true,
            meituanRequirementsEnabled: true,
            issueProjectSources: {
              [project.id]: [{ provider: "meituan", host: "mep.sankuai.com", scope: "6259" }],
            },
          },
        },
      });
      if (saved._tag !== "Success") throw new Error(`Source fixture failed: ${saved.cause}`);
      const skills = await serverEnvironment.mutateSkills.run(appAtomRegistry, {
        environmentId,
        input: {
          type: "batch",
          operations: [
            {
              type: "source.save",
              source: {
                id: "meituan",
                label: "Meituan Skills",
                kind: "mtskills",
                enabled: true,
                executable: "mtskills",
                registry: "http://r.npm.sankuai.com",
              },
            },
          ],
        },
      });
      if (skills._tag !== "Success") throw new Error(`Skills fixture failed: ${skills.cause}`);
      return true;
    }, project);
    await app.open(await browser.evaluate<string>("location.href"));

    await expect(screen.getByText("MEP 6259", { exact: true })).toBeVisible();
    await app.screenshot("mep-source-visible");

    await app.open("/settings/meituan?section=issues");
    await expect(screen.getByText("mep-source", { exact: true })).toBeVisible();
    await expect(screen.getByText("MEP · 6259", { exact: true })).toBeVisible();
    await app.screenshot("meituan-project-source");

    await app.open("/settings/meituan");
    await screen.getByText(/^(Command line tools|命令行工具)$/).tap();
    await expect(screen.getByText("ONES CLI", { exact: true })).toBeVisible();
    await expect(screen.getByText("MCM CLI", { exact: true })).toBeVisible();
    await expect(screen.getByText("Meituan Skills CLI", { exact: true })).toBeVisible();
    await app.screenshot("meituan-service-tools");
  },
);
