import type { SkillMutation } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "A pinned skill can accept a reviewed candidate without enabling automatic updates",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("pinned-skill", {
      "review/SKILL.md":
        "---\nname: candidate-review\ndescription: Review changes\n---\nOriginal.\n",
    });
    await t3.open("/settings/skills");
    await expect(screen.getByRole("button", /^(Install skill|安装技能)$/)).toBeEnabled();
    const mutate = (input: SkillMutation) =>
      browser.evaluate(async (input) => {
        const serverModule = "/src/state/server.ts";
        const registryModule = "/src/rpc/atomRegistry.ts";
        const environmentModule = "/src/state/primaryEnvironment.ts";
        const { serverEnvironment } = await import(serverModule);
        const { appAtomRegistry } = await import(registryModule);
        const { primaryEnvironmentIdAtom } = await import(environmentModule);
        const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
        const result = await serverEnvironment.mutateSkills.run(appAtomRegistry, {
          environmentId,
          input,
        });
        if (result._tag !== "Success") throw new Error("Could not prepare the skill fixture.");
        return null;
      }, input);
    await mutate({
      type: "install",
      sourceId: "local",
      locator: `${project}/review`,
      skill: "",
      targetIds: [],
      policy: "notify",
    });
    await expect(screen.getByText(/^(Saved to library|已保存到管理库)$/)).toBeVisible();
    const id = await browser.evaluate(async () => {
      const serverModule = "/src/state/server.ts";
      const registryModule = "/src/rpc/atomRegistry.ts";
      const environmentModule = "/src/state/primaryEnvironment.ts";
      const { serverEnvironment } = await import(serverModule);
      const { appAtomRegistry } = await import(registryModule);
      const { primaryEnvironmentIdAtom } = await import(environmentModule);
      const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
      return appAtomRegistry.get(serverEnvironment.skills({ environmentId, input: {} })).value
        .skills[0].id;
    });
    await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(
          `${project}/review/SKILL.md`,
          "---\nname: candidate-review\ndescription: Review changes\n---\nReviewed candidate.\n",
        ),
      ),
    );
    await mutate({
      type: "batch",
      operations: [
        { type: "check", id },
        { type: "policy", id, policy: "pinned" },
      ],
    });
    await expect(screen.getByText(/^(No updates|不更新)$/)).toBeVisible();
    await screen.getByRole("button", /^(Review update|查看更新)$/).tap();
    await app.screenshot("reviewed-candidate-while-pinned");
    const apply = screen.getByRole("button", /^(Use candidate version|使用候选版本)$/);
    await expect(apply).toBeEnabled();
    await apply.tap();
    await expect(apply).not.toBeVisible();
    await expect(screen.getByRole("button", /^(Review update|查看更新)$/)).not.toBeVisible();
    await expect(screen.getByText(/^(No updates|不更新)$/)).toBeVisible();
    expect(
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.readFileString(`${T3_HOME}/userdata/skills/active/${id}/SKILL.md`),
        ),
      ),
    ).toContain("Reviewed candidate.");
  },
);
