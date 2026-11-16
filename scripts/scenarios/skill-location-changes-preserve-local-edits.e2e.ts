import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { AsyncResult } from "effect/reactivity";
import type { SkillJob, SkillSnapshot } from "@t3tools/contracts";

import { runPromise, test, WEB } from "./t3.ts";

test(
  "Changing skill locations preserves unresolved local edits",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("skill-location-recovery", {
      "source/SKILL.md": "---\nname: recovery-review\ndescription: Review changes\n---\nFixture.\n",
      "source/script.sh": "original",
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
      const result = await serverEnvironment.mutateSkills.run(appAtomRegistry, {
        environmentId,
        input: {
          type: "batch",
          operations: [
            {
              type: "target.save",
              target: {
                id: "recovery-location",
                label: "Recovery location",
                directory: `${project}/skills`,
              },
            },
            {
              type: "install",
              sourceId: "local",
              locator: `${project}/source`,
              skill: "",
              targetIds: ["recovery-location"],
              policy: "automatic",
            },
          ],
        },
      });
      if (result._tag !== "Success") throw new Error("Could not prepare the fixture skill.");
      return null;
    }, project);
    await expect(screen.getByText(/^(Files ready|文件已就绪)$/)).toBeVisible();
    await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(`${project}/skills/recovery-review/script.sh`, "unresolved user edit"),
      ),
    );
    await screen.getByRole("button", /^(Details|详情)$/).tap();
    await screen.getByRole("button", /^(Check updates|检查更新)$/).tap();
    await expect(screen.getByRole("button", /^(Review update|查看更新)$/)).toBeVisible();
    for (let attempt = 0; attempt < 2; attempt++) {
      const previousIds = await browser.evaluate(async () => {
        const serverModule = "/src/state/server.ts";
        const registryModule = "/src/rpc/atomRegistry.ts";
        const environmentModule = "/src/state/primaryEnvironment.ts";
        const { serverEnvironment } = await import(serverModule);
        const { appAtomRegistry } = await import(registryModule);
        const { primaryEnvironmentIdAtom } = await import(environmentModule);
        const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
        const result = appAtomRegistry.get(serverEnvironment.skills({ environmentId, input: {} }));
        return result._tag === "Success"
          ? (result.value.jobs ?? []).map((job: SkillJob) => job.id)
          : [];
      });
      await screen.getByRole("button", /^(Configure locations|配置使用位置)$/).tap();
      await screen
        .getByRole("dialog")
        .last()
        .getByRole("button", /^(Save|保存)$/)
        .tap();
      await browser.evaluate(async (previousIds) => {
        const serverModule = "/src/state/server.ts";
        const registryModule = "/src/rpc/atomRegistry.ts";
        const environmentModule = "/src/state/primaryEnvironment.ts";
        const { serverEnvironment } = await import(serverModule);
        const { appAtomRegistry } = await import(registryModule);
        const { primaryEnvironmentIdAtom } = await import(environmentModule);
        const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
        const atom = serverEnvironment.skills({ environmentId, input: {} });
        await new Promise<void>((resolve) => {
          const check = (result: AsyncResult.AsyncResult<SkillSnapshot, unknown>) => {
            if (result._tag !== "Success") return;
            const job = result.value.jobs?.findLast(
              (job) => job.input.type === "configure" && !previousIds.includes(job.id),
            );
            if (job?.status !== "completed" && job?.status !== "failed") return;
            unsubscribe();
            resolve();
          };
          const unsubscribe = appAtomRegistry.subscribe(atom, check);
          check(appAtomRegistry.get(atom));
        });
        return null;
      }, previousIds);
    }
    await app.screenshot("local-edits-after-location-changes");
    await expect(screen.getByRole("button", /^(Review update|查看更新)$/)).toBeVisible();
    expect(
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.readFileString(`${project}/skills/recovery-review/script.sh`),
        ),
      ),
    ).toBe("unresolved user edit");
  },
);
