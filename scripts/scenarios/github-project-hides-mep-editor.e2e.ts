import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

test("GitHub issue sources do not offer the MEP space editor", WEB, async ({ t3, app, screen }) => {
  const automatic = await t3.project("automatic-github");
  const manual = await t3.project("manual-github");
  const mep = await t3.project("manual-mep");
  await t3.project("unbound-project");
  await runPromise(
    run("git", ["remote", "add", "origin", "https://github.com/acme/automatic.git"], {
      cwd: automatic,
    }),
  );
  const exercise = async () => {
    await t3.open("/settings/requirements");
    const mepRow = screen.getByRole("row", /manual-mep/);
    await expect(mepRow.getByText(/MEP.*4101/)).toBeVisible();
    await expect(mepRow.getByRole("button", /MEP/)).toBeEnabled();
    for (const [title, github] of [
      ["automatic-github", /^GitHub (Issues|议题)$/],
      [
        "manual-github",
        /GitHub (Issues|议题) · github\.com\/acme\/manual · (Manual override|手动覆盖)/,
      ],
    ] as const) {
      const row = screen.getByRole("row", new RegExp(title));
      await expect(row.getByText(github)).toBeVisible();
      await expect(row.getByRole("button", /MEP/)).toHaveCount(0);
    }
    await app.screenshot("project-issue-sources");
    const unbound = screen.getByRole("row", /unbound-project/);
    await expect(unbound.getByRole("button", /MEP/)).toBeEnabled();
    await unbound.getByRole("checkbox").tap();
    await screen.getByRole("button", /GitHub (override|覆盖)/).tap();
    await screen.getByPlaceholder("owner/repository").fill("acme/first-binding");
    await screen.getByRole("button", /Save GitHub override|保存 GitHub 覆盖/).tap();
    await expect(unbound.getByText(/acme\/first-binding/)).toBeVisible();
    await expect(unbound.getByRole("button", /MEP/)).toHaveCount(0);
    await screen.getByRole("button", /Restore GitHub automatic|恢复 GitHub 自动/).tap();
    await expect(unbound.getByRole("button", /MEP/)).toBeEnabled();
  };
  const { before, after } = await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
      const { snapshot } = yield* client["orchestration.subscribeShell"]({}).pipe(
        Stream.filter((event) => event.kind === "snapshot"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      const manualProject = snapshot.projects.find((project) => project.workspaceRoot === manual);
      const githubProject = snapshot.projects.find(
        (project) => project.workspaceRoot === automatic,
      );
      const mepProject = snapshot.projects.find((project) => project.workspaceRoot === mep);
      if (!manualProject || !mepProject || !githubProject)
        throw new Error("Scenario projects missing");
      const scopes = (refresh: boolean) =>
        client["issues.sources"]({ projectIds: [githubProject.id], refresh }).pipe(
          Effect.map((rows) => rows.flatMap((row) => row.sources.map((source) => source.scope))),
        );
      const verifyScopes = (refresh: boolean, expected: string[]) =>
        scopes(refresh).pipe(
          Effect.flatMap((actual) =>
            Effect.promise(async () => {
              await expect(actual).toEqual(expected);
            }),
          ),
        );
      yield* verifyScopes(true, ["acme/automatic"]);
      yield* run("git", ["remote", "remove", "origin"], { cwd: automatic });
      yield* verifyScopes(true, []);
      yield* verifyScopes(false, []);
      yield* run("git", ["remote", "add", "origin", "https://github.com/acme/renamed.git"], {
        cwd: automatic,
      });
      yield* verifyScopes(true, ["acme/renamed"]);
      yield* verifyScopes(false, ["acme/renamed"]);
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
            [manualProject.id]: [{ provider: "github", host: "github.com", scope: "acme/manual" }],
            [mepProject.id]: [{ provider: "meituan", host: "mep.sankuai.com", scope: "4101" }],
          },
        },
      }).pipe(
        Effect.andThen(
          client["server.updateSettings"]({
            patch: {
              issueProjectSources: {
                [githubProject.id]: [
                  { provider: "meituan", host: "mep.sankuai.com", scope: "4102" },
                ],
              },
            },
          }).pipe(Effect.result),
        ),
        Effect.tap((result) =>
          Effect.promise(async () => {
            await expect(
              result._tag === "Failure" && result.failure._tag === "ServerSettingsError"
                ? result.failure.detail
                : null,
            ).toEqual("A project can use only one requirement provider.");
          }),
        ),
        Effect.andThen(Effect.promise(exercise)),
        Effect.ensuring(
          client["server.updateSettings"]({
            patch: {
              ...before,
              issueProjectSources: {
                [manualProject.id]: [],
                [mepProject.id]: [],
                [githubProject.id]: [],
              },
            },
          }).pipe(Effect.orDie),
        ),
      );
      return { before, after: yield* readFlags };
    }).pipe(Effect.scoped),
  );
  await expect(after).toEqual(before);
});
