import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ProviderModelsSection } from "./ProviderModelsSection";

function setup() {
  const model: ServerProviderModel = {
    slug: "gpt-6-astra",
    name: "GPT 6 Astra",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High", isDefault: true }],
          currentValue: "high",
        },
      ],
    },
  };
  return {
    instanceId: ProviderInstanceId.make("codex_work"),
    driverKind: ProviderDriverKind.make("codex"),
    models: [model],
    customModels: [],
    canManageCustomModels: true,
    hiddenModels: [],
    favoriteModels: [model.slug],
    modelOrder: [model.slug],
    onChange: vi.fn(),
    onHiddenModelsChange: vi.fn(),
    onFavoriteModelsChange: vi.fn(),
    onToggleFavorite: vi.fn(),
    onModelOrderChange: vi.fn(),
  };
}

it.each(
  ["codex", "claudeAgent", "cursor", "grok", "opencode", "pi", "muse", "fx", "acpRegistry"].flatMap(
    (driver) => ["gpt-6-astra", "team-astra"].map((slug) => ({ driver, slug })),
  ),
)(
  "saves a $driver provider model as an editable override using request ID $slug",
  async ({ driver, slug }) => {
    const props = setup();
    props.driverKind = ProviderDriverKind.make(driver);
    const capabilities = props.models[0]!.capabilities!;
    if (driver === "claudeAgent") {
      props.models[0] = {
        ...props.models[0]!,
        capabilities: {
          optionDescriptors: [
            ...(capabilities.optionDescriptors ?? []),
            {
              id: "contextWindow",
              label: "Context Window",
              type: "select",
              options: [{ id: "large", label: "Large", isDefault: true }],
              currentValue: "large",
            },
          ],
        },
      };
    }
    await using screen = await render(<ProviderModelsSection {...props} />);
    const edit = screen.getByRole("button", { name: "Edit gpt-6-astra", exact: true });
    expect(edit.query()).not.toBeNull();
    await userEvent.click(edit);
    await userEvent.fill(screen.getByRole("textbox", { name: "Request model ID (slug)" }), slug);
    await userEvent.fill(screen.getByRole("textbox", { name: "Display name" }), "Team Astra");
    await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));

    expect(props.onChange).toHaveBeenCalledWith([
      {
        slug,
        name: "Team Astra",
        capabilities:
          driver === "claudeAgent" && slug !== "gpt-6-astra"
            ? capabilities
            : props.models[0]!.capabilities,
      },
    ]);
    if (slug !== "gpt-6-astra") {
      expect(props.onHiddenModelsChange).toHaveBeenCalledWith(["gpt-6-astra"], ["gpt-6-astra"]);
      expect(props.onFavoriteModelsChange).toHaveBeenCalledWith([slug]);
      expect(props.onModelOrderChange).toHaveBeenCalledWith([slug]);
    } else {
      expect(props.onHiddenModelsChange).not.toHaveBeenCalled();
      expect(props.onFavoriteModelsChange).not.toHaveBeenCalled();
    }
  },
);

it("rejects another model's ID, cancels without saving, and prevents read-only editing", async () => {
  const props = setup();
  props.models.push({ ...props.models[0]!, slug: "other", name: "Other" });
  await using screen = await render(<ProviderModelsSection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit gpt-6-astra", exact: true }));
  await userEvent.fill(screen.getByRole("textbox", { name: "Request model ID (slug)" }), "other");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await expect.element(screen.getByText("That request model ID is already in use.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(props.onChange).not.toHaveBeenCalled();
  await screen.rerender(<ProviderModelsSection {...props} canManageCustomModels={false} />);
  expect(screen.getByRole("button", { name: "Edit gpt-6-astra", exact: true }).query()).toBeNull();
});

it("edits Antigravity names without changing account-owned IDs or options and resets overrides", async () => {
  const props = setup();
  props.driverKind = ProviderDriverKind.make("antigravity");
  await using screen = await render(<ProviderModelsSection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit gpt-6-astra", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Request model ID (slug)" }))
    .toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Custom option", exact: true }).query()).toBeNull();
  await userEvent.fill(screen.getByRole("textbox", { name: "Display name" }), "Team model");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  const override = {
    slug: "gpt-6-astra",
    name: "Team model",
    capabilities: props.models[0]!.capabilities,
  };
  expect(props.onChange).toHaveBeenCalledWith([override]);
  await screen.rerender(<ProviderModelsSection {...props} customModels={[override]} />);
  await userEvent.click(screen.getByRole("button", { name: "Reset gpt-6-astra", exact: true }));
  expect(props.onChange).toHaveBeenLastCalledWith([]);
  expect(props.onFavoriteModelsChange).not.toHaveBeenCalled();
  expect(props.onModelOrderChange).not.toHaveBeenCalled();
});
