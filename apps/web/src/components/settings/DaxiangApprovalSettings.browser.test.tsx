import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId, type UnifiedSettings } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DaxiangApprovalSettings } from "./DaxiangApprovalSettings";

vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const configs = new Map([
    ["daxiang-settings", { environment: { capabilities: { daxiangApprovalBrowserLogin: true } } }],
  ]);
  const allowed = Atom.make(true);
  return {
    environmentServerConfigsAtom: Atom.make(configs),
    serverEnvironment: {
      updateSettings: { permissionAtom: () => allowed },
      mutateDaxiangApproval: { permissionAtom: () => allowed },
      daxiangApproval: () => null,
    },
  } as unknown as typeof import("~/state/server");
});

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environment: EnvironmentId,
    select: (settings: UnifiedSettings) => unknown,
  ) => select(DEFAULT_UNIFIED_SETTINGS),
}));
vi.mock(import("~/hooks/useUiTranslation"), () => ({ useUiTranslation: () => (text) => text }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ refresh() {} }) }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({
    _tag: "Success",
    value: { threadId: "private-browser:login", tabId: "login-home" },
  }),
}));
vi.mock(import("~/browser/ServerBrowserSurface"), () => ({
  ServerBrowserSurface: ({ tabId, onPopup, onGone }) => (
    <div>
      <span>{tabId}</span>
      <button onClick={() => onPopup?.("sso-popup")}>Open SSO popup</button>
      <button onClick={onGone}>Close browser tab</button>
    </div>
  ),
}));

it("returns to the login page when the SSO popup closes", async () => {
  await using screen = await render(
    <DaxiangApprovalSettings environmentId={EnvironmentId.make("daxiang-settings")} />,
    { router: "/settings/meituan" },
  );
  await userEvent.click(screen.getByRole("button", { name: "Import DaXiang login" }));
  const dialog = page.getByRole("dialog", { name: "DaXiang sign-in" });
  await expect.element(dialog.getByText("login-home")).toBeVisible();
  await act(() =>
    (dialog.getByRole("button", { name: "Open SSO popup" }).element() as HTMLElement).click(),
  );
  await expect.element(dialog.getByText("sso-popup")).toBeVisible();
  await act(() =>
    (dialog.getByRole("button", { name: "Close browser tab" }).element() as HTMLElement).click(),
  );
  await expect.element(dialog.getByText("login-home")).toBeVisible();
});
