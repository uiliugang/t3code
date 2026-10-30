import { useState } from "react";
import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { AppRouteModal } from "../AppRouteModal";
import { CustomModelEditor } from "./CustomModelEditor";

function ModelSettings() {
  const [editing, setEditing] = useState(false);
  return (
    <AppRouteModal label="Provider settings">
      {editing ? (
        <CustomModelEditor
          instanceId="codex_custom"
          driverKind={ProviderDriverKind.make("codex")}
          entry={{ slug: "gpt-6.1-sol", name: "My model", capabilities: null }}
          builtInModels={[]}
          reservedSlugs={[]}
          onCancel={() => setEditing(false)}
          onSave={() => setEditing(false)}
        />
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          Edit model
        </button>
      )}
    </AppRouteModal>
  );
}

it("focuses the request ID and cancels editing with Escape without closing settings", async () => {
  await using _screen = await render(<ModelSettings />);
  await expect.element(page.getByRole("dialog", { name: "Provider settings" })).toHaveFocus();
  await userEvent.click(page.getByRole("button", { name: "Edit model" }));
  await expect
    .element(page.getByRole("textbox", { name: "Request model ID (slug)" }))
    .toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog", { name: "Provider settings" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Edit model" })).toBeVisible();
});
