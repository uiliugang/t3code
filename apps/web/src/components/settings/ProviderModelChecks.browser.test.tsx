import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";

const state = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      validateProviderEndpoint: Object.assign(state.check, { permissionAtom: () => allowed }),
    },
  } as never;
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: unknown) => command) as never,
}));

import {
  ProviderModelChecks,
  ProviderModelTestButton,
  ProviderModelTestResult,
} from "./ProviderModelChecks";

it("keeps cancellation available after the tested model is removed and discards stale results", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  state.check.mockReset();
  let finish!: (result: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  state.check.mockImplementation(({ input }: { input: { check: string } }) => {
    if (input.check === "cancel") finish({ _tag: "Success", value: { message: "old result" } });
    return pending;
  });
  const content = (fingerprint: string, removed = false) => (
    <RegistryProvider>
      <ProviderModelChecks
        environmentId={EnvironmentId.make("local")}
        instanceId={ProviderInstanceId.make("codex_test")}
        disabled={false}
        fingerprint={fingerprint}
      >
        {!removed ? <ProviderModelTestButton slug="Model-A" /> : null}
        <ProviderModelTestButton slug="Model-B" />
        <ProviderModelTestResult slug="Model-A" />
      </ProviderModelChecks>
    </RegistryProvider>
  );
  await using screen = await render(content("before"));
  await userEvent.click(
    screen.getByRole("button", { name: "Test model & tools: Model-A", exact: true }),
  );
  await screen.rerender(content("after", true));
  await expect
    .element(screen.getByRole("button", { name: "Test model & tools: Model-B", exact: true }))
    .toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel check", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Test model & tools: Model-B", exact: true }))
    .toBeEnabled();
  await expect.element(screen.getByText("old result", { exact: true })).not.toBeInTheDocument();
});
