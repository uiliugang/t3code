import {
  DEFAULT_CLIENT_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { providerClients } from "./providerDriverMeta";

it("shows BYOK installation and folds Claude runtime settings by default", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  await using screen = await render(
    <ProviderInstanceCard
      instanceId={ProviderInstanceId.make("claude-byok")}
      instance={{
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { setupMode: "managed", customModelsOnly: true },
      }}
      driverOption={undefined}
      liveProvider={undefined}
      mode="editor"
      setup={<button type="button">Install Claude</button>}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onUpdate={vi.fn()}
      onHiddenModelsChange={vi.fn()}
      onFavoriteModelsChange={vi.fn()}
      onToggleFavorite={vi.fn()}
      onModelOrderChange={vi.fn()}
    />,
  );

  await expect.element(screen.getByRole("button", { name: "Install Claude" })).toBeVisible();
  const runtime = screen.getByRole("button", { name: "Advanced settings", exact: true });
  await expect.element(runtime).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(runtime);
  await expect.element(runtime).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("Driver", { exact: true })).toBeVisible();
  await userEvent.click(runtime);
  await expect.element(runtime).toHaveAttribute("aria-expanded", "false");
});

it("discards a model draft when the instance switches connections", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  const instanceId = ProviderInstanceId.make("codex-switch");
  const driver = ProviderDriverKind.make("codex");
  const onUpdate = vi.fn(async () => true);
  const view = (connectionMode: "existing" | "chatgpt", name: string) => (
    <ProviderInstanceCard
      instanceId={instanceId}
      instance={{ driver, config: { connectionMode, customModels: [{ slug: "shared-id", name }] } }}
      driverOption={providerClients.get(driver)}
      liveProvider={undefined}
      mode="editor"
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onUpdate={onUpdate}
      onHiddenModelsChange={vi.fn()}
      onFavoriteModelsChange={vi.fn()}
      onToggleFavorite={vi.fn()}
      onModelOrderChange={vi.fn()}
    />
  );
  await using screen = await render(view("existing", "Local model"));
  const edit = screen.getByRole("button", { name: "Edit shared-id", exact: true });
  const name = screen.getByRole("textbox", { name: "Display name", exact: true });
  await edit.click();
  await userEvent.fill(name, "Unsaved local draft");

  await screen.rerender(view("chatgpt", "Account model"));
  await expect.element(name).not.toBeInTheDocument();
  expect(onUpdate).not.toHaveBeenCalled();

  await edit.click();
  await expect.element(name).toHaveValue("Account model");
});
