import { RegistryProvider } from "@effect/atom-react";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";

const state = vi.hoisted(() => ({ save: vi.fn(), check: vi.fn() }));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      mutateProviderInstance: Object.assign(state.save, { permissionAtom: () => allowed }) as never,
      validateProviderEndpoint: Object.assign(state.check, {
        permissionAtom: () => allowed,
      }) as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: unknown) => command) as never,
}));

import { ProviderByokSettings } from "./ClaudeByokSettings";

it("clears a rotated credential after saving even when the redacted snapshot is unchanged", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  state.save.mockReset();
  state.check.mockReset();
  const instanceId = ProviderInstanceId.make("claude_byok");
  const instance: ProviderInstanceConfig = {
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    config: { customModelsOnly: true, customModels: ["BA-model"] },
    environment: [
      { name: "ANTHROPIC_BASE_URL", value: "https://ba.test", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true },
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: true },
    ],
  };
  state.save.mockResolvedValue({
    _tag: "Success",
    value: { ...DEFAULT_SERVER_SETTINGS, providerInstances: { [instanceId]: instance } },
  });
  await using screen = await render(
    <RegistryProvider>
      <ProviderByokSettings
        instance={instance}
        instanceId={instanceId}
        environmentId={EnvironmentId.make("test-env")}
        readOnly={false}
        secretSources={[]}
      />
    </RegistryProvider>,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Protocol", exact: true }));
  await userEvent.click(
    screen.getByRole("option", { name: "OpenAI Chat Completions", exact: true }),
  );
  const credential = screen.getByLabelText("BA credential", { exact: true });
  await userEvent.fill(credential, "replacement-token");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  expect(
    state.save.mock.calls[0]?.[0].input.providerInstanceMutation.instance.environment,
  ).toContainEqual({ name: "T3_CLAUDE_API_FORMAT", value: "openai", sensitive: false });
  await expect.element(credential).toHaveValue("");
  await expect.element(screen.getByRole("button", { name: "Check connection" })).toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  state.save.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Save unavailable")),
  });
  await userEvent.fill(credential, "retry-token");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Save unavailable");
  await expect.element(credential).toHaveValue("retry-token");
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

it("allows checking a default Codex instance with implicit enabled state", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  state.save.mockReset();
  state.check.mockReset();
  await using screen = await render(
    <RegistryProvider>
      <ProviderByokSettings
        instanceId={ProviderInstanceId.make("codex")}
        environmentId={EnvironmentId.make("test-env")}
        instance={{
          driver: ProviderDriverKind.make("codex"),
          config: { connectionMode: "byok", customModels: ["test"] },
          environment: [
            { name: "T3_CODEX_BASE_URL", value: "https://api.test/v1", sensitive: false },
            { name: "T3_CODEX_API_KEY", value: "", sensitive: true, valueRedacted: true },
          ],
        }}
        readOnly={false}
        secretSources={[]}
      />
    </RegistryProvider>,
  );
  await expect.element(screen.getByRole("button", { name: "Check connection" })).toBeEnabled();
});
