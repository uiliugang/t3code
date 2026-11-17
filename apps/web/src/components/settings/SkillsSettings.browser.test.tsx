import {
  DEFAULT_CLIENT_SETTINGS,
  type SkillMutation,
  type SkillSnapshot,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { AddSource, InstallDialog } from "./SkillsSettings";

import "../../index.css";

it("requires a new installer selection when Meituan is disabled during source editing", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  const mutate = vi.fn<(input: SkillMutation) => Promise<boolean>>().mockResolvedValue(true);
  await using screen = await render(<AddSource mutate={mutate} disabled={false} meituanEnabled />);
  const name = screen.getByRole("textbox", { name: "New source label" });
  const installer = screen.getByRole("combobox", { name: "Installer type" });
  const submit = screen.getByRole("button", { name: "Add source" });
  await userEvent.fill(name, "Team source");
  await userEvent.click(installer);
  await userEvent.click(page.getByRole("option", { name: "Meituan mtskills" }));
  await expect.element(installer).toHaveTextContent("Meituan mtskills");
  await expect.element(submit).toBeEnabled();

  await screen.rerender(<AddSource mutate={mutate} disabled={false} meituanEnabled={false} />);
  await expect.element(submit).toBeDisabled();
  await expect.element(installer).toHaveTextContent("Choose source");
  await expect.element(name).toHaveValue("Team source");
  expect(mutate).not.toHaveBeenCalled();

  await screen.rerender(<AddSource mutate={mutate} disabled={false} meituanEnabled />);
  await expect.element(installer).toHaveTextContent("Meituan mtskills");
  await expect.element(submit).toBeEnabled();
  await screen.rerender(<AddSource mutate={mutate} disabled={false} meituanEnabled={false} />);
  await expect.element(submit).toBeDisabled();

  await userEvent.click(installer);
  await expect
    .element(page.getByRole("option", { name: "Meituan mtskills" }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("option", { name: "Local directory" }));
  await userEvent.click(submit);
  expect(mutate).toHaveBeenCalledWith({
    type: "source.save",
    source: {
      id: expect.any(String),
      label: "Team source",
      kind: "local",
      enabled: true,
      executable: "",
      registry: "",
    },
  });
});

it("does not replace the selected install source when it is disabled on another client", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  const data: SkillSnapshot = {
    sources: [
      {
        id: "local",
        label: "Local import",
        kind: "local",
        enabled: true,
        executable: "",
        registry: "",
      },
      {
        id: "meituan",
        label: "Meituan Skills",
        kind: "mtskills",
        enabled: true,
        executable: "mtskills",
        registry: "",
      },
    ],
    skills: [],
    customTargets: [],
    targets: [],
    operation: null,
    lastFailure: null,
    discovered: [],
  };
  const mutate = vi.fn<(input: SkillMutation) => Promise<boolean>>().mockResolvedValue(true);
  const onClose = vi.fn();
  await using screen = await render(
    <InstallDialog data={data} mutate={mutate} onClose={onClose} />,
  );
  const source = page.getByRole("combobox", { name: "Skill source" });
  const location = page.getByRole("textbox", { name: "Skill location" });
  const submit = page.getByRole("button", { name: "Save to library" });
  await userEvent.click(source);
  await userEvent.click(page.getByRole("option", { name: "Meituan Skills" }));
  await userEvent.fill(location, "team-skill");
  await expect.element(submit).toBeEnabled();

  await screen.rerender(
    <InstallDialog
      data={{
        ...data,
        sources: data.sources.map((source) =>
          source.kind === "mtskills" ? { ...source, enabled: false } : source,
        ),
      }}
      mutate={mutate}
      onClose={onClose}
    />,
  );
  await expect.element(submit).toBeDisabled();
  await expect.element(source).toHaveTextContent("Choose source");
  await expect.element(location).toHaveValue("team-skill");
  expect(mutate).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  await screen.rerender(<InstallDialog data={data} mutate={mutate} onClose={onClose} />);
  await expect.element(source).toHaveTextContent("Meituan Skills");
  await expect.element(submit).toBeEnabled();
});
