import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { usePreviewPanelInlineSize } from "./usePreviewPanelInlineSize";

const STORAGE_KEY = "test:preview-panel-inline-size";

function Panel({
  containerWidth,
  defaultWidth,
}: {
  containerWidth: number;
  defaultWidth?: number | undefined;
}) {
  const { width, observeRow } = usePreviewPanelInlineSize({
    widthStorageKey: STORAGE_KEY,
    defaultWidth,
  });
  return (
    <div style={{ width: containerWidth }}>
      <div ref={(host) => (host ? observeRow(host) : undefined)} data-testid="panel-width">
        {width}
      </div>
    </div>
  );
}

it.each([
  { viewportWidth: 2100, storedWidth: null, expected: 700 },
  { viewportWidth: 2100, storedWidth: 480, expected: 700 },
  { viewportWidth: 2100, storedWidth: 900, expected: 900 },
  { viewportWidth: 1280, storedWidth: null, expected: 540 },
  { viewportWidth: 1280, storedWidth: 480, expected: 480 },
  { viewportWidth: 2100, storedWidth: null, defaultWidth: 900, expected: 900 },
  { viewportWidth: 2100, containerWidth: 900, storedWidth: 900, expected: 540 },
  { viewportWidth: 1200, containerWidth: 700, storedWidth: 900, expected: 360 },
])("sizes the panel for $viewportWidth px with saved width $storedWidth", async (testCase) => {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  const previousWidth = localStorage.getItem(STORAGE_KEY);
  await using _restore = {
    async [Symbol.asyncDispose]() {
      if (previousWidth === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previousWidth);
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
  if (testCase.storedWidth === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(testCase.storedWidth));
  await page.viewport(testCase.viewportWidth, 900);
  await using screen = await render(
    <Panel
      containerWidth={testCase.containerWidth ?? testCase.viewportWidth}
      defaultWidth={testCase.defaultWidth}
    />,
  );
  await expect
    .element(screen.getByTestId("panel-width"))
    .toHaveTextContent(String(testCase.expected));
  expect(localStorage.getItem(STORAGE_KEY)).toBe(
    testCase.storedWidth === null ? null : JSON.stringify(testCase.storedWidth),
  );

  if (testCase.viewportWidth === 2100 && testCase.storedWidth === 480) {
    await page.viewport(1280, 900);
    await expect.element(screen.getByTestId("panel-width")).toHaveTextContent("480");
    await page.viewport(2400, 900);
    await expect.element(screen.getByTestId("panel-width")).toHaveTextContent("800");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("480");
  }
});
