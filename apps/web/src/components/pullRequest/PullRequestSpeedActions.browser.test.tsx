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
vi.mock(import("./usePullRequestActions"), async (original) => ({
  ...(await original()),
  usePullRequestDefaultMergeMethodResolver: () => () => undefined,
}));

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
