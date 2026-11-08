import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { APP_VERSION } from "../../branding";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { AnchoredToastProvider } from "../ui/toast";
import { AboutVersionTitle } from "./AboutVersionTitle";

it("shows copy confirmation when the version is clicked without waiting for a hover tooltip", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  await using screen = await render(
    <AnchoredToastProvider>
      <AboutVersionTitle />
    </AnchoredToastProvider>,
  );
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

  await screen.getByRole("button", { name: `Copy version ${APP_VERSION}` }).click();

  expect(write).toHaveBeenCalledWith(APP_VERSION);
  await expect.element(page.getByText(/^Copied!?$/)).toBeVisible();
});
