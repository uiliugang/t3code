import { FileTree } from "@pierre/trees";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";

const FOLDERS = 300;

it("opens the file menu for real paths with pointer and keyboard without selecting a diff", async () => {
  const onFileContextMenu = vi.fn();
  const onSelectFile = vi.fn();
  await using _screen = await render(
    <div className="flex h-[600px] flex-col">
      <DiffFileTree
        entries={[
          { path: "src", status: "deleted" },
          { path: "src/index.ts", status: "added" },
        ]}
        onSelectFile={onSelectFile}
        onFileContextMenu={onFileContextMenu}
        ariaLabel="Changed files"
      />
    </div>,
  );
  const file = page.getByRole("treeitem", { name: "src", exact: true }).first();
  await expect.element(file).toBeVisible();
  const row = file.element();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: 120,
      clientY: 160,
    }),
  );
  await vi.waitFor(() => expect(onFileContextMenu).toHaveBeenCalledWith("src", { x: 120, y: 160 }));
  expect(onSelectFile).not.toHaveBeenCalled();

  onFileContextMenu.mockClear();
  await userEvent.click(page.getByRole("treeitem", { name: "src", exact: true }).last(), {
    button: "right",
  });
  expect(onFileContextMenu).not.toHaveBeenCalled();
  await userEvent.keyboard("{Tab}");
  row.focus();
  const anchor = row.getBoundingClientRect();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await vi.waitFor(() => expect(onFileContextMenu).toHaveBeenCalledOnce());
  const [path, position] = onFileContextMenu.mock.calls[0]!;
  expect(path).toBe("src");
  expect(position.x).toBeGreaterThanOrEqual(anchor.left);
  expect(position.x).toBeLessThanOrEqual(anchor.right);
  expect(position.y).toBeGreaterThanOrEqual(anchor.top);
  expect(position.y).toBeLessThanOrEqual(anchor.bottom);
  expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row);
});

it("expands every folder without asking the tree about all folders for each one", async () => {
  // Two levels, so flattening empty folders cannot merge them into one.
  const entries: DiffFileTreeEntry[] = Array.from({ length: FOLDERS }, (_, index) => [
    { path: `package-${index}/a.ts`, status: "modified" as const },
    { path: `package-${index}/lib/b.ts`, status: "modified" as const },
  ]).flat();
  using getItem = vi.spyOn(FileTree.prototype, "getItem");
  await using _screen = await render(
    <div className="flex h-[600px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={() => {}} ariaLabel="Changed files" />
    </div>,
  );
  const collapseAll = page.getByRole("button", { name: "Collapse all folders" });
  await expect.element(collapseAll).toBeVisible();
  await userEvent.click(collapseAll);
  const expandAll = page.getByRole("button", { name: "Expand all folders" });
  await expect.element(expandAll).toBeVisible();
  getItem.mockClear();
  await userEvent.click(expandAll);
  await expect.element(page.getByRole("button", { name: "Collapse all folders" })).toBeVisible();
  // Each of the expansions used to look up the folders again from the first one, so the lookups
  // grew with the square of the folder count (hundreds of thousands at 600 folders).
  expect(getItem.mock.calls.length).toBeLessThan(FOLDERS * 2 * 20);
});
