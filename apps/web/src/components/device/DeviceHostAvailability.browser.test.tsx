import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DeviceHostAvailability } from "./DeviceHostAvailability";

it("does not report an unavailable platform as available in the tooltip", async () => {
  await using screen = await render(
    <DeviceHostAvailability platforms={[{ platform: "android", available: false }]} />,
  );
  await userEvent.hover(screen.getByText("Android unavailable"));
  await vi.waitFor(() => {
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
      "Android unavailable",
    );
  });
});
