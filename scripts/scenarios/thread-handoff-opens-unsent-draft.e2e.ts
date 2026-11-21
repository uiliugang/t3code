import { expect } from "e2e";

import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { environmentId, makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "A thread handoff opens an unsent draft on the chosen machine",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const sourceProject = await t3.project("source-project");
    const source = await t3.thread({
      project: sourceProject,
      title: "Release checklist",
      messages: ["Review the release checklist"],
    });
    const sourceEnvironment = await runPromise(environmentId(app.baseUrl ?? ""));
    const sourceUrl = `/${sourceEnvironment}/${source.threadId}`;
    const action = screen
      .getByRole("button", /Continue on another machine|在另一台机器继续/)
      .last();
    await t3.open(sourceUrl);
    await expect(screen.getByRole("button", /Copy message|复制消息/).last()).toBeVisible();
    await expect(action).toHaveCount(0);
    const second = startSecondServer(app.baseUrl ?? "");
    try {
      const { host, token } = await second.ready;
      await makeState(SECOND_HOME).state.project("target-project");
      await t3.open("/settings/connections");
      await screen.getByRole("button", /Add environment|添加环境/).tap();
      const pairing = screen.getByRole("dialog", /^(Add environment|添加环境)$/);
      await pairing.getByPlaceholder("backend.example.com").fill(host);
      await pairing.getByPlaceholder(/PAIRCODE|配对码/).fill(token);
      await pairing.getByRole("button", /Add environment|添加环境/).tap();
      await expect(pairing).toBeHidden();

      await app.open(sourceUrl);
      await expect(action).toBeVisible();
      await action.hover();
      await app.screenshot("handoff-reply-actions");
      await action.tap();
      const handoff = screen.getByRole("dialog", /Continue on another machine|在另一台机器继续/);
      await expect(handoff.getByText(/ · target-project/)).toBeVisible();
      await app.screenshot("handoff-dialog");
      await handoff.getByRole("button", /Open draft|打开草稿/).tap();

      await expect(browser).toHaveURL(/\/draft\//);
      await expect(screen.getByRole("textbox")).toContainText(
        /using the attached thread record|参考附带的线程记录/,
      );
      await expect(screen.getByText(/Release checklist-.+\.jsonl/).first()).toBeVisible();
      await expect(screen.getByRole("button", /Stop generation|停止生成/)).toBeHidden();
      await app.screenshot("handoff-draft");
    } finally {
      await second.stop();
    }
  },
);
