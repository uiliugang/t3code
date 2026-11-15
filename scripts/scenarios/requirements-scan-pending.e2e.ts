import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Scanning stays locked after the project menu closes",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("scan-project");
    await t3.open("/requirements");
    // Hold the real RPC on the wire so the menu closes before the server can answer.
    await browser.evaluate(`() => {
    const send = WebSocket.prototype.send;
    const pending = [];
    WebSocket.prototype.send = function(data) {
      const text = typeof data === 'string' ? data :
        data instanceof Blob ? '' : new TextDecoder().decode(data);
      if (text.includes('workItems.discover')) pending.push({ socket: this, data });
      else send.call(this, data);
    };
    window.releaseScan = () => {
      WebSocket.prototype.send = send;
      for (const request of pending) send.call(request.socket, request.data);
      delete window.releaseScan;
    };
  }`);
    const scan = screen.getByRole("button", /^(Scan chats|扫描会话)/);
    try {
      await scan.tap();
      await screen.getByRole("menuitem").first().tap();
      await screen.getByRole("menuitem", "scan-project").tap();
      await expect(screen.getByRole("menuitem", "scan-project")).not.toBeVisible();
      await app.screenshot("scan-pending");
      await expect(scan).toBeDisabled();
    } finally {
      await browser.evaluate("() => window.releaseScan?.()");
    }
    await expect(scan).toBeEnabled();
  },
);
