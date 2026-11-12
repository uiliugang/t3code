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
  const runtime = screen.getByRole("button", { name: "Runtime", exact: true });
  await expect.element(runtime).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(runtime);
  await expect.element(runtime).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("Driver", { exact: true })).toBeVisible();
  await userEvent.click(runtime);
  await expect.element(runtime).toHaveAttribute("aria-expanded", "false");
});
