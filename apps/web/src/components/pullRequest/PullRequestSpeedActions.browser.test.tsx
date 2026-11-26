import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { PullRequestSpeedActions, PullRequestSpeedModeContext } from "./PullRequestSpeedActions";

const run = vi.hoisted(() => vi.fn().mockResolvedValue({ _tag: "Success" }));

vi.mock(import("~/hooks/useUiTranslation"), async () => {
  const { translateUi } = await import("@t3tools/shared/uiLocale");
  return { useUiTranslation: () => translateUi.bind(null, "en") };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => run }));
vi.mock(import("~/state/pullRequests"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { pullRequestEnvironment: { runAction: { permissionAtom: () => allowed } } } as never;
});
vi.mock(import("~/hooks/useSettings"), async (original) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    ...(await original()),
    useEnvironmentSettings: ((
      _environmentId: unknown,
      select: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown,
    ) =>
      select?.({
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [ProjectId.make("route")]: { pullRequestMergeMethod: "merge" },
          [ProjectId.make("owner")]: { pullRequestMergeMethod: "squash" },
        },
      })) as never,
  };
});
vi.mock(import("~/state/entities"), async (original) => {
  const provider = SourceControlProviderKind.make("gitlab");
  return {
    ...(await original()),
    useServerConfigs: (() =>
      new Map([
        ["test", { environment: { capabilities: { pullRequestWebTargets: true } } }],
      ])) as never,
    useProjects: (() => [
      {
        id: ProjectId.make("route"),
        environmentId: EnvironmentId.make("test"),
        repositoryIdentity: {
          provider,
          canonicalKey: "forge.test/acme/sibling",
          displayName: "acme/sibling",
          locator: { remoteUrl: "http://forge.test/acme/sibling.git" },
        },
      },
      {
        id: ProjectId.make("owner"),
        environmentId: EnvironmentId.make("test"),
        repositoryIdentity: {
          provider,
          canonicalKey: "forge.test/acme/repo",
          displayName: "acme/repo",
          locator: { remoteUrl: "git@forge.test:acme/repo.git" },
        },
      },
    ]) as never,
  };
});

it("closes the listed merge request, retaining its provider and Web origin", async () => {
  const provider = SourceControlProviderKind.make("gitlab");
  const entry = {
    environmentId: EnvironmentId.make("test"),
    projectId: ProjectId.make("project"),
    host: "forge.test",
    target: { provider, origin: "http://forge.test" },
    repository: "acme/repo",
    number: 7,
    state: "open" as const,
    isDraft: false,
  };
  await using screen = await render(
    <PullRequestSpeedModeContext value={true}>
      <PullRequestSpeedActions
        entry={entry}
        terminology={sourceControlClients.get(provider).changeRequest}
        hostActions={new Set(["close"])}
      />
    </PullRequestSpeedModeContext>,
  );
  await screen.getByRole("button", { name: "Close #7" }).click();
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ action: "close", target: entry.target }),
    }),
  );
});

it("merges through the routed checkout with the target repository's preference", async () => {
  run.mockClear();
  const provider = SourceControlProviderKind.make("gitlab");
  const entry = {
    environmentId: EnvironmentId.make("test"),
    projectId: ProjectId.make("route"),
    host: "forge.test",
    target: { provider, origin: "http://forge.test" },
    repository: "acme/repo",
    number: 7,
    state: "open" as const,
    isDraft: false,
  };
  await using screen = await render(
    <PullRequestSpeedModeContext value={true}>
      <PullRequestSpeedActions
        entry={entry}
        terminology={sourceControlClients.get(provider).changeRequest}
        hostActions={new Set(["merge"])}
      />
    </PullRequestSpeedModeContext>,
  );
  await screen.getByRole("button", { name: "Merge #7" }).click();
  const input = run.mock.lastCall?.[0]?.input;
  expect(input).toMatchObject({
    projectId: entry.projectId,
    target: entry.target,
    action: "merge",
  });
  expect(
    input.resolveMergeMethod({
      capabilities: { mergeMethods: ["merge", "squash"] },
      mergeCapabilities: { merge: true, squash: true },
    }),
  ).toBe("squash");
});
