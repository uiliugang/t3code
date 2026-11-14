import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const decodeStarted = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);
const decodeShown = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ thread: Schema.Struct({ worktreePath: Schema.String }) })),
);

test(
  "worktree inspection handles large ignored dependency directories",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("cleanup-dependencies", { ".gitignore": "node_modules/\n" });
    const { cli } = makeState(T3_HOME);
    await runPromise(
      Effect.gen(function* () {
        const started = yield* cli([
          "thread",
          "start",
          project,
          "Inspect dependencies",
          "--title",
          "Dependency cleanup",
          "--provider",
          "devReplay",
          "--model",
          "multi-turn",
          "--worktree",
          "main",
          "--wait",
          "--json",
        ]);
        const { threadId } = yield* decodeStarted(started.stdout);
        const shown = yield* cli(["thread", "show", threadId, "--json"]);
        const { thread } = yield* decodeShown(shown.stdout);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dependencies = path.join(thread.worktreePath, "node_modules");
        yield* fs.makeDirectory(dependencies, { recursive: true });
        yield* Effect.forEach(
          Array.from({ length: 5_000 }, (_, index) =>
            path.join(dependencies, `${index}-${"dependency".repeat(23)}.js`),
          ),
          (file) => fs.writeFileString(file, ""),
          { concurrency: 32, discard: true },
        );
      }),
    );
    await t3.open("/settings/worktrees");
    await expect(browser.locator("#local-worktrees")).toContainText("Dependency cleanup");
    await browser.locator("#local-worktrees").scrollIntoView();
    await app.screenshot("worktree-inspection");
    await expect(screen.getByText(/^(Inspection failed|检查失败)$/)).toHaveCount(0);
    await expect(screen.getByText(/Historical branch|历史分支/)).toHaveCount(0);
  },
);
