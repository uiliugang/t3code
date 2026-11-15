import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "an unavailable linked issue can still be unlinked",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("unavailable-issue");
    const thread = await t3.thread({
      project,
      title: "Unlink unavailable issue",
      messages: ["Ready"],
    });
    await runPromise(
      Effect.gen(function* () {
        const digest = yield* Digest.Digest;
        const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
        const git = (args: ReadonlyArray<string>) => run("git", args, { cwd: project });
        const branch = (yield* git(["branch", "--show-current"])).stdout.trim();
        yield* git(["remote", "add", "origin", "https://github.com/acme/app.git"]);
        yield* git(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
        const key = Hex.encode(
          yield* digest.digest(
            Digest.sha256,
            new TextEncoder().encode(yield* encode(["github.com/acme/app", branch])),
          ),
        );
        yield* git([
          "config",
          `t3issues.${key}.links`,
          yield* encode([
            {
              provider: "github",
              id: "1",
              url: "https://github.com/acme/app/issues/1",
              repository: "acme/app",
              title: "Unavailable issue",
              state: "open",
              association: "local",
            },
          ]),
        ]);
      }).pipe(Effect.provide(NodeCrypto.layer)),
    );
    await t3.open(thread);
    const details = screen.getByRole("button", "Toggle thread details panel");
    await expect(details).toBeVisible();
    if (
      !(await browser.evaluate<boolean>(
        `document.querySelector('button[aria-label="Toggle thread details panel"]')?.getAttribute("aria-pressed") === "true"`,
      ))
    )
      await details.tap();
    const issue = screen.getByRole("button", /Unavailable issue acme\/app #1 open/);
    await app.screenshot("unavailable-linked-issue");
    await expect(issue).toBeVisible();
    await issue.tap();
    const unlink = screen.getByRole("button", /^(Unlink issue|解除关联)$/);
    await expect(unlink).toBeEnabled();
    await unlink.tap();
    await expect(issue).not.toBeVisible();
    await expect(screen.getByRole("button", /^(Link issues|关联需求)$/)).toBeEnabled();
    await app.screenshot("unlinked-issue");
  },
);
