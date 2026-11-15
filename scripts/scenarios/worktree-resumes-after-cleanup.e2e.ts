import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeLaunched = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);
const decodeWorktree = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ thread: Schema.Struct({ worktreePath: Schema.String }) })),
);

test(
  "A thread resumes after its worktree and local branch are cleaned up",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("worktree-resume");
    const git = (args: ReadonlyArray<string>) => runPromise(run("git", args, { cwd: project }));
    const cli = (args: ReadonlyArray<string>) =>
      run(process.execPath, ["apps/server/src/bin.ts", ...args, "--base-dir", T3_HOME], {
        cwd: APP_DIR,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
    const remote = `${project}/remote.git`;
    await git(["clone", "--bare", project, remote]);
    await git(["remote", "add", "origin", remote]);
    const launched = await runPromise(
      cli([
        "thread",
        "start",
        project,
        "Start before cleanup",
        "--worktree",
        "main",
        "--branch",
        "resume-after-cleanup",
        "--provider",
        "devReplay",
        "--model",
        "multi-turn",
        "--wait",
        "--json",
      ]).pipe(Effect.flatMap(({ stdout }) => decodeLaunched(stdout))),
    );
    const { thread } = await runPromise(
      cli(["thread", "show", launched.threadId, "--json"]).pipe(
        Effect.flatMap(({ stdout }) => decodeWorktree(stdout)),
      ),
    );
    await t3.open("/settings/worktrees");
    await screen
      .getByRole(
        "switch",
        /Only create worktrees from main\/master|仅允许从 main\/master 创建工作树/,
      )
      .uncheck();
    await t3.open(launched);
    await git(["worktree", "remove", thread.worktreePath]);
    await git(["branch", "-D", "resume-after-cleanup"]);

    await screen.getByRole("textbox").fill("Continue after cleanup");
    await screen.getByRole("textbox").press("Enter");
    try {
      await expect(
        screen.getByText("second fixture turn complete", { exact: false }),
      ).toBeVisible();
    } finally {
      await app.screenshot("worktree-resumed");
    }
  },
);
