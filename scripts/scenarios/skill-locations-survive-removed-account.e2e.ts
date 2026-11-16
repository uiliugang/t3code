import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

test(
  "Skill locations remain editable after an account sharing the directory is removed",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("skill-locations", {
      "source/SKILL.md": "---\nname: location-review\ndescription: Review changes\n---\nFixture.\n",
    });
    await t3.open("/settings/skills");
    await expect(screen.getByRole("button", /^(Install skill|安装技能)$/)).toBeEnabled();
    await browser.evaluate(async (project) => {
      const serverModule = "/src/state/server.ts";
      const registryModule = "/src/rpc/atomRegistry.ts";
      const environmentModule = "/src/state/primaryEnvironment.ts";
      const { serverEnvironment } = await import(serverModule);
      const { appAtomRegistry } = await import(registryModule);
      const { primaryEnvironmentIdAtom } = await import(environmentModule);
      const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
      for (const [instanceId, displayName] of [
        ["location-old", "Old account"],
        ["location-replacement", "Replacement account"],
      ]) {
        const result = await serverEnvironment.updateSettings.run(appAtomRegistry, {
          environmentId,
          input: {
            patch: {},
            providerInstanceMutation: {
              operation: "upsert",
              instanceId,
              instance: {
                driver: "claudeAgent",
                displayName,
                enabled: false,
                config: { homePath: `${project}/old-home` },
              },
            },
          },
        });
        if (result._tag !== "Success") throw new Error("Could not prepare fixture accounts.");
      }
      const result = await serverEnvironment.mutateSkills.run(appAtomRegistry, {
        environmentId,
        input: {
          type: "batch",
          operations: [
            {
              type: "target.save",
              target: {
                id: "location-next",
                label: "Next location",
                directory: `${project}/next-home/skills`,
              },
            },
            {
              type: "install",
              sourceId: "local",
              locator: `${project}/source`,
              skill: "",
              policy: "pinned",
              targetIds: ["location-old"],
            },
          ],
        },
      });
      if (result._tag !== "Success") throw new Error("Could not prepare the fixture skill.");
      return null;
    }, project);
    await expect(screen.getByText(/^(Files ready|文件已就绪)$/)).toBeVisible();
    await browser.evaluate(async () => {
      const serverModule = "/src/state/server.ts";
      const registryModule = "/src/rpc/atomRegistry.ts";
      const environmentModule = "/src/state/primaryEnvironment.ts";
      const { serverEnvironment } = await import(serverModule);
      const { appAtomRegistry } = await import(registryModule);
      const { primaryEnvironmentIdAtom } = await import(environmentModule);
      const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
      const result = await serverEnvironment.updateSettings.run(appAtomRegistry, {
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: { operation: "delete", instanceId: "location-old" },
        },
      });
      if (result._tag !== "Success") throw new Error("Could not remove the fixture account.");
      return null;
    });
    await app.open("/settings/skills");
    await screen.getByRole("button", /^(Details|详情)$/).tap();
    await screen.getByRole("button", /^(Configure locations|配置使用位置)$/).tap();
    const dialog = screen.getByRole("dialog").last();
    await app.screenshot("locations-after-account-removal");
    await expect(dialog.getByRole("checkbox", "Replacement account")).toBeChecked();
    await dialog.getByRole("checkbox", "Next location").tap();
    await dialog.getByRole("button", /^(Save|保存)$/).tap();
    await expect(screen.getByText(/^(2\/2 locations linked|已关联 2\/2 个位置)$/)).toBeVisible();
    expect(
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.readFileString(`${project}/next-home/skills/location-review/SKILL.md`),
        ),
      ),
    ).toContain("Fixture.");
  },
);
