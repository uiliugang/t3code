import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { CloudSandboxSettings } from "./CloudSandboxSettings";

vi.mock(import("../../hooks/useUiTranslation"), async () => {
  const { translateUi } = await import("@t3tools/shared/uiLocale");
  return { useUiTranslation: () => translateUi.bind(null, "en") };
});

it("unlocks server setup only after confirming a reset of unreadable credentials", async () => {
  const bridge = {
    getCloudSandboxConfig: vi.fn().mockRejectedValue(new Error("unreadable credentials")),
    saveCloudSandboxConfig: vi.fn(),
    clearCloudSandboxConfig: vi.fn(),
    resetCloudSandboxConfig: vi.fn().mockResolvedValue(undefined),
  };
  await using screen = await render(
    <>
      <CloudSandboxSettings bridge={bridge} initiallyOpen />
      <ConfirmDialogHost />
    </>,
  );
  const reset = screen.getByRole("button", { name: "Reset credentials" });
  const add = screen.getByRole("button", { name: "Add server" });
  const dialog = page.getByRole("alertdialog");
  await expect.element(add).toBeDisabled();
  await userEvent.click(reset);
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await expect.element(reset).toBeEnabled();
  expect(bridge.resetCloudSandboxConfig).not.toHaveBeenCalled();

  await userEvent.click(reset);
  await userEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await expect.element(add).toBeEnabled();
  await expect
    .element(screen.getByText("Could not read the Cloud Sandbox credential."))
    .not.toBeInTheDocument();
});

it("requires a password for a different endpoint but accepts an equivalent address", async () => {
  const config = { hostname: "sandbox.example.test", port: 22 };
  const bridge = {
    getCloudSandboxConfig: vi.fn().mockResolvedValue([config]),
    saveCloudSandboxConfig: vi.fn().mockResolvedValue([config]),
    clearCloudSandboxConfig: vi.fn(),
    resetCloudSandboxConfig: vi.fn(),
  };
  await using screen = await render(<CloudSandboxSettings bridge={bridge} initiallyOpen />);
  await userEvent.click(screen.getByRole("button", { name: "Edit server" }));
  const host = screen.getByRole("textbox", { name: "SSH host" });
  const save = screen.getByRole("button", { name: "Save configuration" });
  await userEvent.fill(host, "sandbox.example.test:2222");
  await userEvent.click(save);
  await expect.element(screen.getByText("Enter a password for this SSH host.")).toBeVisible();
  expect(bridge.saveCloudSandboxConfig).not.toHaveBeenCalled();

  await userEvent.fill(host, "SANDBOX.example.test:22");
  await userEvent.click(save);
  await expect.element(screen.getByText("Configuration saved")).toBeVisible();
});
