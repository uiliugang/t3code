import "~/index.css";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { IssueCreateDialog } from "./IssueCreateDialog";

const calls = vi.hoisted(() => ({ create: vi.fn(), metadata: vi.fn(), people: vi.fn() }));
const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const sources = [
  { provider: "github", host: "forge.example.test", scope: "team/repo" },
  { provider: "github", host: "forge.example.test:8443", scope: "team/repo" },
];

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => true) as never,
}));
vi.mock(import("../../hooks/useUiTranslation"), async () => {
  const { translateUi } = await import("@t3tools/shared/uiLocale");
  return { useUiTranslation: () => translateUi.bind(null, "en") };
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((data: unknown) => ({ data })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => calls.create) as never,
}));
vi.mock(import("../../state/sourceControl"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    sourceControlEnvironment: {
      ...actual.sourceControlEnvironment,
      issueSources: (() => [{ projectId, sources }]) as never,
      issueMetadata: ((input: unknown) => {
        calls.metadata(input);
        return null;
      }) as never,
      issuePeople: ((input: unknown) => {
        calls.people(input);
        return null;
      }) as never,
      createIssue: { permissionAtom: () => Atom.make(true) } as never,
    },
  };
});
vi.mock(import("./DraftFillButton"), () => ({ DraftFillButton: () => <></> }));

it("uses the selected GitHub authority for requests and the newly created issue", async () => {
  const created = vi.fn();
  const issue = { id: "7", url: "https://forge.example.test:8443/team/repo/issues/7" };
  calls.create.mockResolvedValue({ _tag: "Success", value: issue });
  await using screen = await render(
    <IssueCreateDialog
      environmentId={environmentId}
      provider="github"
      projects={[{ id: projectId, title: "Example" }]}
      close={vi.fn()}
      created={created}
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "GitHub repository" }));
  await userEvent.click(screen.getByRole("option", { name: "forge.example.test:8443/team/repo" }));
  await userEvent.fill(screen.getByRole("textbox", { name: /Title/ }), "Separate instances");
  await userEvent.click(screen.getByRole("button", { name: "Create issue" }));
  const selected = {
    environmentId,
    input: expect.objectContaining({ projectId, ...sources[1] }),
  };
  expect(calls.metadata).toHaveBeenLastCalledWith(selected);
  expect(calls.people).toHaveBeenLastCalledWith(selected);
  expect(calls.create).toHaveBeenCalledWith(selected);
  expect(created).toHaveBeenCalledWith(issue, selected.input);
});
