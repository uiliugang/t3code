// @effect-diagnostics globalFetch:off - browser.evaluate configures the isolated scenario server.
// @effect-diagnostics nodeBuiltinImport:off - the local fixture holds naming until setup is visible.
import * as NodeHttp from "node:http";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeLaunched = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);

test(
  "Setup completion is visible while branch naming is still running",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const setupFinished = Promise.withResolvers<void>();
    const requests = new Set<NodeHttp.ServerResponse>();
    const reply = () => {
      for (const response of requests) {
        response.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: '{"branch":"setup-fix"}' } }],
          }),
        );
      }
      requests.clear();
    };
    const server = NodeHttp.createServer((request, response) => {
      request.resume();
      if (request.url === "/setup-finished") {
        response.end("OK");
        setupFinished.resolve();
      } else {
        response.setHeader("content-type", "application/json");
        requests.add(response);
      }
    });
    using _server = {
      [Symbol.dispose]() {
        reply();
        server.closeAllConnections();
        server.close();
      },
    };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing model gate port");
    const origin = `http://127.0.0.1:${address.port}`;
    const project = await t3.project("setup-progress", {
      "setup.cjs": `require("node:http").get(${JSON.stringify(`${origin}/setup-finished`)}, response => response.resume()).on("error", () => process.exit(1));`,
    });
    await t3.open();
    await expect(screen.getByRole("button", "New thread in setup-progress").first()).toBeVisible();
    await browser.evaluate(
      async ({ baseUrl, workspaceRoot }: { baseUrl: string; workspaceRoot: string }) => {
        const { environmentId } = (await fetch("/.well-known/t3/environment").then((response) =>
          response.json(),
        )) as { environmentId: string };
        const serverModule = "/src/state/server.ts";
        const registryModule = "/src/rpc/atomRegistry.ts";
        const { serverEnvironment } = await import(serverModule);
        const { appAtomRegistry } = await import(registryModule);
        const saved = await serverEnvironment.updateSettings.run(appAtomRegistry, {
          environmentId,
          input: {
            patch: {
              newWorktreesStartFromOrigin: false,
              sourceControlWriterModelSelection: { instanceId: "fixture", model: "fixture" },
              textGenerators: {
                fixture: {
                  kind: "openaiCompatible",
                  baseUrl,
                  apiKey: "",
                  model: "fixture",
                  enabled: true,
                },
              },
            },
          },
        });
        if (saved._tag !== "Success")
          throw new Error(`Could not configure the naming fixture: ${JSON.stringify(saved)}`);
        const { projects } = (await fetch("/api/projects").then((response) => response.json())) as {
          projects: Array<{
            id: string;
            workspaceRoot: string;
            workspaceConfig?: { version: number };
          }>;
        };
        const project = projects.find((entry) => entry.workspaceRoot === workspaceRoot);
        if (!project) throw new Error("Scenario project is missing");
        const projectModule = "/src/state/projects.ts";
        const { projectEnvironment } = await import(projectModule);
        const updated = await projectEnvironment.update.run(appAtomRegistry, {
          environmentId,
          input: {
            projectId: project.id,
            expectedWorkspaceVersion: project.workspaceConfig?.version ?? 0,
            workspaceConfig: {
              primaryRootId: "root",
              roots: [
                {
                  id: "root",
                  alias: "app",
                  sourcePath: workspaceRoot,
                  description: "",
                  defaultSelected: true,
                  accessIntent: "write",
                  defaultBaseRef: "main",
                  setupScript: {
                    id: "setup",
                    name: "Setup",
                    command: "node setup.cjs",
                    icon: "configure",
                    runOnWorktreeCreate: true,
                  },
                },
              ],
            },
          },
        });
        if (updated._tag !== "Success")
          throw new Error(`Could not configure the workspace fixture: ${JSON.stringify(updated)}`);
        return true;
      },
      { baseUrl: `${origin}/v1`, workspaceRoot: project },
    );
    const launched = await runPromise(
      run(
        process.execPath,
        [
          "apps/server/src/bin.ts",
          "thread",
          "start",
          project,
          "Fix setup status",
          "--title",
          "Setup progress",
          "--worktree",
          "main",
          "--provider",
          "devReplay",
          "--model",
          "showcase",
          "--json",
          "--base-dir",
          T3_HOME,
        ],
        { cwd: APP_DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      ).pipe(Effect.flatMap(({ stdout }) => decodeLaunched(stdout))),
    );
    await setupFinished.promise;
    await t3.open(launched);
    const naming = browser.locator('[data-worktree-setup-stage="naming"]');
    const setup = browser.locator('[data-worktree-setup-stage="setup-script"]');
    await expect(naming).toHaveAttribute("data-worktree-setup-status", "running");
    await browser.evaluate(() => {
      document
        .querySelector('[data-worktree-setup-stage="naming"]')
        ?.scrollIntoView({ block: "center" });
      return true;
    });
    await app.screenshot("setup-finished-during-naming");
    await expect(setup).toHaveAttribute("data-worktree-setup-status", "done");
    reply();
  },
);
