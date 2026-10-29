import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { ComboboxTrigger } from "./ui/combobox";
import "../index.css";

it("updates current branch badges when the ref names stay the same", async () => {
  const names = ["main", "feature"];
  const picker = (current: string) => (
    <BranchPicker
      items={names}
      filteredItems={names}
      value={current}
      query=""
      onQueryChange={() => {}}
      open
      onOpenChange={() => {}}
      onSelectItem={() => {}}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadNext={() => {}}
      statusText={null}
      popupProps={{ className: "flex h-60 w-80 flex-col" }}
      renderItem={(name, index) => (
        <BranchPickerRefItem
          branch={{
            name,
            current: name === current,
            isDefault: name === "main",
            worktreePath: name === current ? "/repo" : null,
          }}
          projectCwd="/repo"
          index={index}
          onClick={() => {}}
        />
      )}
    >
      <ComboboxTrigger>Branches</ComboboxTrigger>
    </BranchPicker>
  );
  await using screen = await render(picker("main"));
  await expect.element(page.getByRole("option", { name: /main/ })).toMatchTextContent(/current/);
  await expect
    .element(page.getByRole("option", { name: /feature/ }))
    .not.toMatchTextContent(/current/);

  await screen.rerender(picker("feature"));
  await expect
    .element(page.getByRole("option", { name: /main/ }))
    .not.toMatchTextContent(/current/);
  await expect.element(page.getByRole("option", { name: /feature/ })).toMatchTextContent(/current/);
});
