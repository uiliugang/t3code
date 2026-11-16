import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "An empty requirements board settles after its first live snapshot",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("requirements-empty");
    await t3.open("/requirements?source=local");
    await app.screenshot("local-requirements");
    await expect(
      screen.getByText(/^(No matching work items\.|没有符合条件的需求或任务。)$/),
    ).toBeVisible();
  },
);
