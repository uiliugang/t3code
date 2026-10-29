import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { gitCheckoutChanges } from "./gitCheckoutCommand.ts";

it.layer(Path.layer)("gitCheckoutChanges", (it) => {
  it.effect.each([
    ["git switch -c feature/one", [{ cwd: "/code/repo", checkoutPath: "/code/repo" }]],
    ["git checkout -B fix/one main", [{ cwd: "/code/repo", checkoutPath: "/code/repo" }]],
    ["git checkout feature/existing", [{ cwd: "/code/repo", checkoutPath: "/code/repo" }]],
    [
      "git worktree add -b fix/one '../new worktree' main",
      [{ cwd: "/code/repo", checkoutPath: "/code/new worktree" }],
    ],
    [
      "git worktree add --lock --reason 'review copy' --detach --force ../review HEAD",
      [{ cwd: "/code/repo", checkoutPath: "/code/review" }],
    ],
    [
      "cd '/code/other repo' && git -C nested worktree add -B fix/new ../checkout main",
      [{ cwd: "/code/other repo/nested", checkoutPath: "/code/other repo/checkout" }],
    ],
    [
      "/bin/zsh -lc 'git worktree add -b fix/demo ../demo main && git -C ../demo status'",
      [{ cwd: "/code/repo", checkoutPath: "/code/demo" }],
    ],
    [
      'git switch -c feature/local && git worktree add --no-checkout -b feature/remote "../remote copy"',
      [
        { cwd: "/code/repo", checkoutPath: "/code/repo" },
        { cwd: "/code/repo", checkoutPath: "/code/remote copy" },
      ],
    ],
    [
      "git worktree add ../unconfirmed; git worktree add -b final ../confirmed\n",
      [{ cwd: "/code/repo", checkoutPath: "/code/confirmed" }],
    ],
    [
      "pwd\ngit -C /code/backend worktree add -d -- ../detached HEAD",
      [{ cwd: "/code/backend", checkoutPath: "/code/detached" }],
    ],
    [
      "bash -c 'cd /code/backend && git worktree add ../backend-copy' && git worktree add ../frontend-copy",
      [
        { cwd: "/code/backend", checkoutPath: "/code/backend-copy" },
        { cwd: "/code/repo", checkoutPath: "/code/frontend-copy" },
      ],
    ],
    [
      "git worktree add '../literal-$name' && git worktree add ../escaped\\ space",
      [
        { cwd: "/code/repo", checkoutPath: "/code/literal-$name" },
        { cwd: "/code/repo", checkoutPath: "/code/escaped space" },
      ],
    ],
  ] as const)("recognizes an explicit checkout change: %s", ([command, expected]) =>
    Effect.gen(function* () {
      expect(gitCheckoutChanges(command, "/code/repo", yield* Path.Path)).toEqual(expected);
    }),
  );

  it.effect.each([
    'echo "git worktree add -b fake ../fake"',
    "git worktree list --porcelain",
    "git branch feature/without-checkout",
    "git checkout -- src/file.ts",
    "git checkout HEAD src/file.ts",
    "git worktree add -b feature/missing-path",
    "git worktree add ../failed; true",
    "git worktree add ../failed\ntrue",
    "cd /missing; git worktree add ../unknown",
    "git worktree add $CHECKOUT_PATH",
    'git worktree add "$(pwd)/checkout"',
    "git worktree add `pwd`/checkout",
    "git worktree add ~/checkout",
    "git worktree add ../checkout-*",
    "git worktree add ../checkout || true",
    "git worktree add ../checkout | cat",
    "git worktree add ../checkout &",
    "git worktree add ../checkout > /tmp/output",
    "git worktree add '../unfinished",
    "if true; then git worktree add ../checkout; fi",
    "exit 0 && git worktree add ../never-ran",
    "exec true && git worktree add ../never-ran",
    "set -n && git worktree add ../never-ran",
    "command cd /code/other && git worktree add ../unknown",
  ])("ignores commands that cannot establish a successful checkout change: %s", (command) =>
    Effect.gen(function* () {
      expect(gitCheckoutChanges(command, "/code/repo", yield* Path.Path)).toEqual([]);
    }),
  );
});
