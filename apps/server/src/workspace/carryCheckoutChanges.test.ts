import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { applyCarriedCheckoutChanges, readCarriedCheckoutChanges } from "./carryCheckoutChanges.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "carry-checkout-changes-" })),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live(
  "carries root and nested staged/unstaged patches under diff.noprefix, preserves non-UTF-8 bytes, and reproduces safe untracked symlinks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "carry-changes-" });
      const repo = path.join(temp, "repo");
      const target = path.join(temp, "worktree");
      yield* fs.makeDirectory(path.join(repo, "apps/server"), { recursive: true });
      yield* git.execute({ operation: "test", cwd: repo, args: ["init", "-b", "main"] });
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["config", "diff.noprefix", "true"],
      });
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["config", "diff.mnemonicPrefix", "true"],
      });
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["config", "diff.suppressBlankEmpty", "true"],
      });
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["config", "apply.whitespace", "error"],
      });

      yield* fs.writeFileString(path.join(repo, "root.txt"), "root base\n\ncontext\n");
      yield* fs.writeFileString(
        path.join(repo, "apps/server/nested.ts"),
        "export const value = 1;\n",
      );
      const latin1Base = new Uint8Array([
        0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9, 0x0a, 0x32, 0x0a,
      ]);
      yield* fs.writeFile(path.join(repo, "latin1.txt"), latin1Base);
      yield* git.execute({ operation: "test", cwd: repo, args: ["add", "."] });
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
      });
      const head = (yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();

      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["worktree", "add", "-b", "fork-target", target, head],
      });

      // Staged changes on root + nested files (with trailing whitespace)
      yield* fs.writeFileString(path.join(repo, "root.txt"), "root staged  \n\ncontext\n");
      yield* fs.writeFileString(
        path.join(repo, "apps/server/nested.ts"),
        "export const value = 2;  \n",
      );
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["add", "root.txt", "apps/server/nested.ts"],
      });

      // Unstaged changes on root + nested + non-UTF-8 text file
      yield* fs.writeFileString(path.join(repo, "root.txt"), "root unstaged  \n\ncontext\n");
      yield* fs.writeFileString(
        path.join(repo, "apps/server/nested.ts"),
        "export const value = 3;\n",
      );
      const latin1Edited = new Uint8Array([
        0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9, 0x0a, 0xf1, 0x0a,
      ]);
      yield* fs.writeFile(path.join(repo, "latin1.txt"), latin1Edited);

      // Untracked file and relative symlink pointing inside the checkout
      yield* fs.writeFileString(path.join(repo, "untracked.txt"), "untracked payload\n");
      yield* fs.symlink("../../untracked.txt", path.join(repo, "apps/server/link-inside.txt"));

      const changes = yield* readCarriedCheckoutChanges({
        git,
        fs,
        sourceCwd: repo,
        commit: head,
      });
      yield* applyCarriedCheckoutChanges({
        git,
        fs,
        path,
        targetCheckoutRoot: yield* fs.realPath(target),
        changes,
      });

      assert.equal(
        yield* fs.readFileString(path.join(target, "root.txt")),
        "root unstaged  \n\ncontext\n",
      );
      assert.equal(
        yield* fs.readFileString(path.join(target, "apps/server/nested.ts")),
        "export const value = 3;\n",
      );
      const stagedInTarget = (yield* git.execute({
        operation: "test",
        cwd: target,
        args: ["show", ":apps/server/nested.ts"],
      })).stdout;
      assert.equal(stagedInTarget, "export const value = 2;  \n");
      assert.deepEqual(yield* fs.readFile(path.join(target, "latin1.txt")), latin1Edited);
      assert.equal(
        yield* fs.readLink(path.join(target, "apps/server/link-inside.txt")),
        "../../untracked.txt",
      );
      assert.equal(
        yield* fs.readFileString(path.join(target, "apps/server/link-inside.txt")),
        "untracked payload\n",
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.live(
  "rejects untracked symlinks escaping the checkout, symlink parents, and unmerged index conflicts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "carry-changes-safety-" });
      const repo = path.join(temp, "repo");
      const target = path.join(temp, "worktree");
      const outside = path.join(temp, "outside");
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* fs.makeDirectory(outside, { recursive: true });
      yield* fs.writeFileString(path.join(outside, "secret.txt"), "secret\n");
      yield* git.execute({ operation: "test", cwd: repo, args: ["init", "-b", "main"] });
      yield* fs.writeFileString(path.join(repo, "conflict.txt"), "base\n");
      yield* git.execute({ operation: "test", cwd: repo, args: ["add", "."] });
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
      });
      const head = (yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["worktree", "add", "-b", "safety-target", target, head],
      });
      const realTarget = yield* fs.realPath(target);

      // 1. Untracked symlink pointing outside checkout is explicitly rejected
      yield* fs.symlink("../outside/secret.txt", path.join(repo, "escape-link"));
      const escapeChanges = yield* readCarriedCheckoutChanges({
        git,
        fs,
        sourceCwd: repo,
        commit: head,
      });
      const escapeFailure = yield* applyCarriedCheckoutChanges({
        git,
        fs,
        path,
        targetCheckoutRoot: realTarget,
        changes: escapeChanges,
      }).pipe(Effect.flip);
      assert.include(escapeFailure.detail, "pointing outside checkout");
      yield* fs.remove(path.join(repo, "escape-link"));

      // 2. Destination parent directory being a symlink is explicitly rejected
      yield* fs.makeDirectory(path.join(repo, "dir"), { recursive: true });
      yield* fs.writeFileString(path.join(repo, "dir/file.txt"), "payload\n");
      yield* fs.symlink(outside, path.join(realTarget, "dir"));
      const parentSymlinkChanges = yield* readCarriedCheckoutChanges({
        git,
        fs,
        sourceCwd: repo,
        commit: head,
      });
      const parentFailure = yield* applyCarriedCheckoutChanges({
        git,
        fs,
        path,
        targetCheckoutRoot: realTarget,
        changes: parentSymlinkChanges,
      }).pipe(Effect.flip);
      assert.include(parentFailure.detail, "symbolic link parent");
      assert.isFalse(yield* fs.exists(path.join(outside, "file.txt")));
      yield* fs.remove(path.join(repo, "dir"), { recursive: true });

      yield* fs.writeFileString(path.join(repo, "dangling.txt"), "payload");
      yield* fs.symlink(path.join(outside, "missing.txt"), path.join(target, "dangling.txt"));
      const dangling = yield* readCarriedCheckoutChanges({
        git,
        fs,
        sourceCwd: repo,
        commit: head,
      });
      const danglingFailure = yield* applyCarriedCheckoutChanges({
        git,
        fs,
        path,
        targetCheckoutRoot: realTarget,
        changes: dangling,
      }).pipe(Effect.flip);
      assert.include(danglingFailure.detail, "symbolic link destination");
      assert.isFalse(yield* fs.exists(path.join(outside, "missing.txt")));
      yield* fs.remove(path.join(repo, "dangling.txt"));
      yield* fs.writeFileString(path.join(repo, "large.data"), "");
      yield* fs.truncate(path.join(repo, "large.data"), 257 * 1024 * 1024);
      const large = yield* readCarriedCheckoutChanges({ git, fs, sourceCwd: repo, commit: head });
      const largeFailure = yield* applyCarriedCheckoutChanges({
        git,
        fs,
        path,
        targetCheckoutRoot: realTarget,
        changes: large,
      }).pipe(Effect.flip);
      assert.include(largeFailure.detail, "256 MiB");
      assert.isFalse(yield* fs.exists(path.join(target, "large.data")));
      yield* fs.remove(path.join(repo, "large.data"));

      // 3. Unmerged conflict in source checkout fails explicitly instead of silently dropping changes
      yield* git.execute({ operation: "test", cwd: repo, args: ["checkout", "-b", "other"] });
      yield* fs.writeFileString(path.join(repo, "conflict.txt"), "other\n");
      yield* git.execute({ operation: "test", cwd: repo, args: ["add", "conflict.txt"] });
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "other",
        ],
      });
      yield* git.execute({ operation: "test", cwd: repo, args: ["checkout", "main"] });
      yield* fs.writeFileString(path.join(repo, "conflict.txt"), "main\n");
      yield* git.execute({ operation: "test", cwd: repo, args: ["add", "conflict.txt"] });
      yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "main"],
      });
      const merge = yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "other"],
        allowNonZeroExit: true,
      });
      assert.equal(merge.exitCode, 1);
      const unmerged = yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["ls-files", "--unmerged"],
      });
      assert.include(unmerged.stdout, "conflict.txt");
      const mainHead = (yield* git.execute({
        operation: "test",
        cwd: repo,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      const unmergedFailure = yield* readCarriedCheckoutChanges({
        git,
        fs,
        sourceCwd: repo,
        commit: mainHead,
      }).pipe(Effect.flip);
      assert.include(unmergedFailure.detail, "Resolve merge conflicts");
    }).pipe(Effect.provide(layer), Effect.scoped),
);
