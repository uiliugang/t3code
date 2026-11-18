import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";
import type { SkillJob, SkillSnapshot } from "@t3tools/contracts";

import { runPromise, test, WEB } from "./t3.ts";
import { T3_HOME } from "../e2e.config.ts";

test(
  "Location changes finish and stay visible while a skill version waits for idle agents",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("skill-pending-locations", {
      "source/SKILL.md": "---\nname: pending-review\ndescription: Review changes\n---\nFixture.\n",
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
                id: "pending-location",
                label: "Pending location",
                directory: `${project}/skills`,
              },
            },
            {
              type: "install",
              sourceId: "local",
              locator: `${project}/source`,
              skill: "",
              targetIds: ["pending-location"],
              policy: "automatic",
            },
          ],
        },
      });
      if (result._tag !== "Success") throw new Error("Could not prepare the fixture skill.");
      return null;
    }, project);
    await expect(screen.getByText(/^(Files ready|文件已就绪)$/)).toBeVisible();
    const restore = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settingsPath = (yield* Path.Path).join(T3_HOME, "userdata/settings.json");
        const original = yield* fs.readFileString(settingsPath);
        const json = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
        const settings = yield* Schema.decodeEffect(json)(original);
        yield* fs.writeFileString(
          settingsPath,
          yield* Schema.encodeEffect(json)({
            ...settings,
            defaultRuntimeMode: "approval-required",
          }),
        );
        return fs.writeFileString(settingsPath, original);
      }),
    );
    try {
      await t3.thread({
        project,
        title: "Active agent awaiting approval",
        messages: ["Wait for approval"],
        model: "approval",
      });
    } finally {
      await runPromise(restore);
    }
    await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(`${project}/source/script.sh`, "pending version"),
      ),
    );
    await browser.evaluate(async () => {
      const serverModule = "/src/state/server.ts";
      const registryModule = "/src/rpc/atomRegistry.ts";
      const environmentModule = "/src/state/primaryEnvironment.ts";
      const { serverEnvironment } = await import(serverModule);
      const { appAtomRegistry } = await import(registryModule);
      const { primaryEnvironmentIdAtom } = await import(environmentModule);
      const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
      const data = appAtomRegistry.get(serverEnvironment.skills({ environmentId, input: {} }));
      if (data._tag !== "Success") throw new Error("Skills are not available.");
      const result = await serverEnvironment.mutateSkills.run(appAtomRegistry, {
        environmentId,
        input: { type: "update", id: data.value.skills[0].id },
      });
      if (result._tag !== "Success") throw new Error("Could not prepare the pending version.");
      return null;
    });
    await expect(
      screen.getByText(/^(Waiting for idle agents|等待智能体空闲后应用)$/).first(),
    ).toBeVisible();
    await screen.getByRole("button", /^(Details|详情)$/).tap();
    await screen.getByRole("button", /^(Configure locations|配置使用位置)$/).tap();
    await screen
      .getByRole("dialog")
      .last()
      .getByRole("button", /^(Save|保存)$/)
      .tap();
    const job = await browser.evaluate(async () => {
      const serverModule = "/src/state/server.ts";
      const registryModule = "/src/rpc/atomRegistry.ts";
      const environmentModule = "/src/state/primaryEnvironment.ts";
      const { serverEnvironment } = await import(serverModule);
      const { appAtomRegistry } = await import(registryModule);
      const { primaryEnvironmentIdAtom } = await import(environmentModule);
      const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
      const atom = serverEnvironment.skills({ environmentId, input: {} });
      return await new Promise<SkillJob>((resolve) => {
        const check = (result: AsyncResult.AsyncResult<SkillSnapshot, unknown>) => {
          if (result._tag !== "Success") return;
          const job = result.value.jobs?.findLast((job) => job.input.type === "configure");
          if (!job || job.status === "queued" || job.status === "running") return;
          unsubscribe();
          resolve(job);
        };
        const unsubscribe = appAtomRegistry.subscribe(atom, check);
        check(appAtomRegistry.get(atom));
      });
    });
    await app.screenshot("location-result-with-pending-version");
    expect(job.status).toBe("completed");
    expect(job.afterDigest).toBe(job.beforeDigest);
    await screen.getByRole("textbox", /^(Search skills|搜索技能)$/).fill("no-matching-skills");
    await app.screenshot("location-feedback-outside-filtered-list");
    await expect(
      screen.getByText(
        /^(Usage locations updated\. Running agents may need a new session or reload to use the changes\.|使用位置已更新。运行中的智能体可能需要新建会话或重新加载才能使用这些变更。)$/,
      ),
    ).toBeVisible();
  },
);
