// @effect-diagnostics nodeBuiltinImport:off - the HTTP fixture holds Git fetch until the browser observes its progress.
// @effect-diagnostics globalFetch:off cryptoRandomUUID:off - browser.evaluate runs in the browser without Effect services.
import * as NodeHttp from "node:http";
import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "worktree naming stays pending until checkout is ready",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const pending = new Set<NodeHttp.ServerResponse>();
    const remote = NodeHttp.createServer((_request, response) => {
      pending.add(response);
      response.on("close", () => pending.delete(response));
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    try {
      const address = remote.address();
      if (address === null || typeof address === "string") throw new Error("No Git fixture port");
      const cwd = await t3.project("worktree-fetch-progress");
      await runPromise(
        run("git", ["remote", "add", "origin", `http://127.0.0.1:${address.port}/repo.git`], {
          cwd,
        }),
      );
      await t3.open();
      await expect(
        screen.getByRole("button", "New thread in worktree-fetch-progress").first(),
      ).toBeVisible();
      await browser.evaluate(async (sourcePath: string) => {
        const { projects } = (await fetch("/api/projects").then((response) => response.json())) as {
          projects: Array<{
            id: string;
            workspaceRoot: string;
            workspaceConfig?: { version: number };
          }>;
        };
        const project = projects.find(
          (candidate: { workspaceRoot: string }) => candidate.workspaceRoot === sourcePath,
        );
        if (project === undefined) throw new Error("Workspace fixture project is missing");
        const response = await fetch("/api/projects/mutate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "project.update",
            commandId: crypto.randomUUID(),
            projectId: project.id,
            expectedWorkspaceVersion: project.workspaceConfig?.version ?? 0,
            workspaceConfig: {
              primaryRootId: "repo",
              roots: [
                {
                  id: "repo",
                  alias: "repo",
                  sourcePath,
                  description: "",
                  accessIntent: "write",
                  defaultSelected: true,
                },
              ],
            },
          }),
        });
        if (!response.ok) throw new Error(`Workspace fixture failed: ${response.status}`);
        return response.status;
      }, cwd);
      const { cli } = makeState(T3_HOME);
      await runPromise(
        cli([
          "thread",
          "start",
          cwd,
          "Check workspace progress",
          "--title",
          "Fetch progress regression",
          "--provider",
          "devReplay",
          "--model",
          "showcase",
          "--worktree",
          "main",
        ]),
      );
      await screen.getByText("Fetch progress regression").first().tap();
      const fetchStage = browser.locator('[data-worktree-setup-stage="fetch"]');
      await expect(fetchStage).toHaveAttribute("data-worktree-setup-status", "running");
      await app.screenshot("fetch-progress");
      await expect(browser.locator('[data-worktree-setup-stage="naming"]')).toHaveAttribute(
        "data-worktree-setup-status",
        "pending",
      );
      for (const response of pending) response.writeHead(401).end();
      await expect(browser.locator('[data-worktree-setup-phase="failed"]')).toBeVisible();
      await expect(fetchStage).toHaveAttribute("data-worktree-setup-status", "failed");
      await expect(
        screen.getByText("Git could not authenticate with the remote.", { exact: false }).first(),
      ).toBeVisible();
      await expect(screen.getByRole("button", "Cancel")).toHaveCount(0);
      await app.screenshot("fetch-failed");
    } finally {
      remote.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        remote.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
