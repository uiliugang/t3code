import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "A repository failure does not tell users their issue account needs authorization",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("requirements-repository-error");
    const directory = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.makeTempDirectory({ prefix: "t3-issue-repository-" }),
      ),
    );
    const { cli } = makeState(T3_HOME);
    try {
      await runPromise(cli(["project", "add", directory, "--title", "MEP-repository-error"]));
      await t3.open("/requirements?source=meituan");
      await expect(screen.getByText("MEP-repository-error", { exact: false })).toBeVisible();
      await app.screenshot("repository-error");
      await expect(
        screen.getByText(
          /Check that its workspace exists and is a Git repository|请确认工作目录存在且为 Git 仓库/,
        ),
      ).toBeVisible();
    } finally {
      await runPromise(cli(["project", "remove", directory, "--force"]));
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(directory, { recursive: true })),
      );
    }
  },
);
