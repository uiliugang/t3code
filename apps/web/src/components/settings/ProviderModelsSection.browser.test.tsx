import type { ComponentProps } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ProviderModelsSection } from "./ProviderModelsSection";

vi.mock(import("../../hooks/useUiTranslation"), async () => {
  const { translateUi } = await import("@t3tools/shared/uiLocale");
  return { useUiTranslation: () => translateUi.bind(null, "en") };
});

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
    onChange: vi.fn(async () => true),
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

function section(props: Partial<ComponentProps<typeof ProviderModelsSection>>) {
  return (
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("claude")}
      driverKind={ProviderDriverKind.make("claudeAgent")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={async () => true}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
      {...props}
    />
  );
}

it("lists a favorite the provider no longer reports so it can be unstarred", async () => {
  const onToggleFavorite = vi.fn();
  await using screen = await render(
    section({ favoriteModels: ["retired-model"], onToggleFavorite }),
  );
  await screen.getByRole("button", { name: "Remove retired-model from favorites" }).click();
  expect(onToggleFavorite).toHaveBeenCalledWith("retired-model");
});

it("keeps favorite and order preferences until custom model removal succeeds", async () => {
  const model = { slug: "my-model", name: "My model", capabilities: null };
  const results: Array<(saved: boolean) => void> = [];
  const onChange = () => new Promise<boolean>((resolve) => results.push(resolve));
  const onFavoriteModelsChange = vi.fn();
  const onModelOrderChange = vi.fn();
  await using screen = await render(
    section({
      onChange,
      models: [{ ...model, isCustom: true }],
      customModels: [model],
      favoriteModels: [model.slug],
      modelOrder: [model.slug],
      onFavoriteModelsChange,
      onModelOrderChange,
    }),
  );
  const remove = screen.getByRole("button", { name: "Remove my-model", exact: true });
  await remove.click();
  await act(() => results[0]!(false));
  expect(onFavoriteModelsChange).not.toHaveBeenCalled();
  expect(onModelOrderChange).not.toHaveBeenCalled();

  await remove.click();
  await act(() => results[1]!(true));
  expect(onFavoriteModelsChange).toHaveBeenCalledExactlyOnceWith([]);
  expect(onModelOrderChange).toHaveBeenCalledExactlyOnceWith([]);
});

it("keeps custom model drafts until they save, so a failed save can be retried", async () => {
  const saves: Array<(saved: boolean) => void> = [];
  const onChange = () => new Promise<boolean>((resolve) => saves.push(resolve));
  const kept = { slug: "kept-model", name: "kept-model", capabilities: null };
  await using screen = await render(
    section({ onChange, models: [{ ...kept, isCustom: true }], customModels: [kept] }),
  );
  const addCustomModel = screen.getByRole("button", { name: "Add custom model" });
  const input = screen.getByRole("textbox");
  const add = screen.getByRole("button", { name: "Add", exact: true });

  await userEvent.click(addCustomModel);
  await userEvent.type(input, "my-model{Enter}");
  await expect.element(add).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(saves).toHaveLength(1);
  await act(() => saves[0]!(false));
  await expect.element(add).toBeEnabled();
  await expect.element(input).toHaveValue("my-model");

  await userEvent.click(add);
  await act(() => saves[1]!(true));
  await expect.element(input).not.toBeInTheDocument();

  // A save the user cancelled must not close the draft opened after it.
  await userEvent.click(addCustomModel);
  await userEvent.type(input, "other-model{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(addCustomModel);
  await act(() => saves[2]!(true));
  await expect.element(add).toBeEnabled();

  await userEvent.click(screen.getByRole("button", { name: "Edit kept-model", exact: true }));
  const displayName = screen.getByRole("textbox", { name: "Display name", exact: true });
  await userEvent.fill(displayName, "Renamed");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await act(() => saves[3]!(false));
  await expect.element(displayName).toHaveValue("Renamed");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await act(() => saves[4]!(true));
  await expect.element(displayName).not.toBeInTheDocument();
});

it("keeps changes typed while an earlier save succeeds", async () => {
  const saves: Array<(saved: boolean) => void> = [];
  const onChange = () => new Promise<boolean>((resolve) => saves.push(resolve));
  const kept = { slug: "kept-model", name: "kept-model", capabilities: null };
  await using screen = await render(
    section({ onChange, models: [{ ...kept, isCustom: true }], customModels: [kept] }),
  );
  await screen.getByRole("button", { name: "Edit kept-model", exact: true }).click();
  const displayName = screen.getByRole("textbox", { name: "Display name", exact: true });
  const save = screen.getByRole("button", { name: "Save", exact: true });
  await userEvent.fill(displayName, "Submitted draft");
  await save.click();
  const modelId = screen.getByRole("textbox", { name: "Request model ID (slug)" });
  await userEvent.fill(modelId, "new-request-id");
  await act(() => saves[0]!(true));
  await expect.element(modelId).toHaveValue("new-request-id");
  await save.click();
  await act(() => saves[1]!(true));
  await expect.element(displayName).not.toBeInTheDocument();
});
