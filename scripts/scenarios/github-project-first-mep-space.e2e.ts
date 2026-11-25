import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "GitHub-only projects can link their first MEP space",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const automatic = await t3.project("automatic-github");
    const manual = await t3.project("manual-github");
    await runPromise(
      run("git", ["remote", "add", "origin", "https://github.com/acme/automatic.git"], {
        cwd: automatic,
      }),
    );
    const exercise = async () => {
      await t3.open("/settings/requirements");
      for (const [title, github, space] of [
        ["automatic-github", /^GitHub (Issues|议题)$/, "4101"],
        [
          "manual-github",
          /GitHub (Issues|议题) · github\.com\/acme\/manual · (Manual override|手动覆盖)/,
          "4102",
        ],
      ] as const) {
        const row = screen.getByRole("row", new RegExp(title));
        await expect(row.getByText(github)).toBeVisible();
        await expect(row.getByText(/No MEP space linked|尚未关联 MEP 空间/)).toHaveCount(0);
        const pencil = row.getByRole("button", /MEP/);
        await app.screenshot(`${title}-first-link`);
        await expect(pencil).toBeEnabled();
        await pencil.tap();
        await row.getByRole("textbox").fill(space);
        await row.getByRole("button", /^(Save|保存)$/).tap();
        const linked = row.getByText(new RegExp(`MEP.*${space}`));
        await expect(linked).toBeVisible();
        await app.open(await browser.evaluate<string>("location.href"));
        await expect(linked).toBeVisible();
        await expect(row.getByText(github)).toBeVisible();
      }
    };
    const { before, after } = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        const { snapshot } = yield* client["orchestration.subscribeShell"]({}).pipe(
          Stream.filter((event) => event.kind === "snapshot"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const projects = snapshot.projects.filter(
          (project) => project.workspaceRoot === manual || project.workspaceRoot === automatic,
        );
        const manualProject = projects.find((project) => project.workspaceRoot === manual);
        if (!manualProject || projects.length !== 2) throw new Error("Scenario projects missing");
        const readFlags = client["server.getSettings"]({}).pipe(
          Effect.map(({ meituanIntegrationEnabled, meituanRequirementsEnabled }) => ({
            meituanIntegrationEnabled,
            meituanRequirementsEnabled,
          })),
        );
        const before = yield* readFlags;
        yield* client["server.updateSettings"]({
          patch: {
            meituanIntegrationEnabled: true,
            meituanRequirementsEnabled: true,
            issueProjectSources: {
              [manualProject.id]: [
                { provider: "github", host: "github.com", scope: "acme/manual" },
              ],
            },
          },
        }).pipe(
          Effect.andThen(Effect.promise(exercise)),
          Effect.ensuring(
            client["server.updateSettings"]({
              patch: {
                ...before,
                issueProjectSources: Object.fromEntries(projects.map(({ id }) => [id, []])),
              },
            }).pipe(Effect.orDie),
          ),
        );
        return { before, after: yield* readFlags };
      }).pipe(Effect.scoped),
    );
    await expect(after).toEqual(before);
  },
);
