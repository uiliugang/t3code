// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SourceControlProviderError, SourceControlProviderKind } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

// Windows forbids CR and LF in file names.
const lineBreakSuffixes = HostProcess.Platform.defaultValue() === "win32" ? [] : ["\r", "\n"];
const bareLayouts = [
  "bare clone",
  "dot-bare",
  ...lineBreakSuffixes.map((suffix) => `bare clone${suffix}`),
];

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect.each([
    "ssh://git@git.sankuai.com/SA/service.git",
    "https://git.sankuai.com/scm/SA/service.git",
  ])("identifies the Meituan repository behind %s", (remote) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-meituan-identity-" });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.canonicalKey).toBe("git.sankuai.com/sa/service");
      expect(identity?.provider).toBe("meituan");
      expect(identity?.owner?.toLowerCase()).toBe("sa");
      expect(identity?.name).toBe("service");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath matches git's long paths when Windows temp dirs use 8.3 names.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
      expect(yield* resolver.resolve(path.join(cwd, ".git"))).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("identifies the host of an SSH remote that leaves its user to ssh config", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-userless-remote-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.displayName).toBe("T3Tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("keys a remote behind an SSH host alias by the host ssh config resolves it to", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const aliasDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-ssh-alias-test-",
      });
      const plainDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-ssh-plain-test-",
      });

      yield* git(aliasDir, ["init"]);
      yield* git(aliasDir, ["remote", "add", "origin", "git@work:owner/repo.git"]);
      yield* git(plainDir, ["init"]);
      yield* git(plainDir, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);

      const runner = yield* ProcessRunner.ProcessRunner;
      const resolver = yield* RepositoryIdentityResolver.make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) =>
            input.command === "ssh" && input.args.includes("-G")
              ? Effect.succeed({
                  stdout: input.args.includes("git@work.alias")
                    ? "hostname forge.example.test\n"
                    : input.args.includes("git@work.alias.test")
                      ? "hostname ssh.github.com\nport 443\n"
                      : input.args.includes("git@work")
                        ? "user git\nhostname github.com\nport 22\n"
                        : `hostname ${input.args.at(-1) ?? ""}\nport 22\n`,
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                })
              : runner.run(input),
        }),
      );

      const aliasIdentity = yield* resolver.resolve(aliasDir);
      const plainIdentity = yield* resolver.resolve(plainDir);

      expect(plainIdentity?.canonicalKey).toBe("github.com/owner/repo");
      expect(aliasIdentity?.canonicalKey).toBe(plainIdentity?.canonicalKey);
      expect(aliasIdentity?.provider).toBe(plainIdentity?.provider);
      expect(aliasIdentity?.locator.remoteUrl).toBe("git@work:owner/repo.git");
      yield* git(aliasDir, ["remote", "set-url", "origin", "git@work.alias.test:me/fork.git"]);
      const transport = yield* resolver.resolve(aliasDir, { refresh: true });
      expect(sourceControlDefinitions.issueBindings(transport)).toEqual([
        { tracker: "github", host: "github.com", scope: "me/fork" },
      ]);
      yield* git(aliasDir, ["remote", "add", "upstream", "https://github.com/org/parent.git"]);
      expect((yield* resolver.resolve(aliasDir, { refresh: true }))?.origin).toMatchObject({
        canonicalKey: "github.com/me/fork",
        remoteUrl: "git@work.alias.test:me/fork.git",
      });
      yield* git(aliasDir, ["remote", "set-url", "upstream", "git@work.alias:org/parent.git"]);
      for (const origin of [
        "https://forge.example.test/me/fork.git",
        "git@forge.example.test:me/fork.git",
        "ssh://git@forge.example.test/me/fork.git",
      ]) {
        yield* git(aliasDir, ["remote", "set-url", "origin", origin]);
        const fork = yield* resolver.resolve(aliasDir, { refresh: true });
        expect(fork?.canonicalKey).toBe("forge.example.test/org/parent");
        expect(fork?.locator.remoteUrl).toBe("git@work.alias:org/parent.git");
        expect(fork?.origin?.canonicalKey).toBe("forge.example.test/me/fork");
      }
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("resolves an Azure DevOps remote as generic Git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-azure-git-suffix-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, [
        "remote",
        "add",
        "origin",
        "https://dev.azure.com/Acme/Platform/_git/Tool.git",
      ]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.provider).toBe("unknown");
      expect(identity?.displayName).toBe("Acme/Platform/_git/Tool");
      expect(identity?.name).toBe("Tool");
      expect(sourceControlDefinitions.repositorySelector(identity)).toBe("Acme/Platform/_git/Tool");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("does not treat an unanswered enterprise provider probe as a settled unknown", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "https://forge.example.test/team/web.git"]);
      let offline = true;
      let probes = 0;
      const resolver = yield* RepositoryIdentityResolver.make({
        refine: (identity) => {
          probes++;
          return offline && identity.provider !== "github"
            ? Effect.fail(
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("unknown"),
                  operation: "detectProvider",
                  cwd,
                  detail: "Credential lookup timed out.",
                }),
              )
            : Effect.succeed({ ...identity, provider: SourceControlProviderKind.make("github") });
        },
      });
      expect((yield* resolver.resolve(cwd, { remoteOnly: true }))?.canonicalKey).toBe(
        "forge.example.test/team/web",
      );
      expect(probes).toBe(0);
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("forge.example.test/team/web");
      const strict = { onUnavailable: () => Effect.fail("unavailable") };
      expect((yield* resolver.resolve(cwd, strict).pipe(Effect.result))._tag).toBe("Failure");
      offline = false;
      expect((yield* resolver.resolve(cwd, strict))?.provider).toBe("github");
      yield* git(cwd, ["remote", "set-url", "origin", "https://forge.example.test/team/new.git"]);
      expect(
        (yield* resolver.resolve(cwd, { remoteOnly: true, refresh: true }))?.canonicalKey,
      ).toBe("forge.example.test/team/new");
      expect((yield* resolver.resolve(cwd, strict))?.canonicalKey).toBe(
        "forge.example.test/team/new",
      );
      yield* git(cwd, ["remote", "rename", "origin", "upstream"]);
      yield* git(cwd, ["remote", "add", "origin", "https://github.com/team/fork.git"]);
      offline = true;
      expect((yield* resolver.resolve(cwd, { ...strict, refresh: true }))?.canonicalKey).toBe(
        "forge.example.test/team/new",
      );
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("resolves the fetch remote of a partial clone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-partial-clone-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["remote", "set-url", "--push", "origin", "git@github.com:T3Tools/push.git"]);
      yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
      yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

      const remotes = yield* git(cwd, ["remote", "-v"]);
      expect(remotes.stdout).toContain("(fetch) [blob:none]");

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.locator.remoteUrl).toBe("git@github.com:T3Tools/t3code.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("resolves a remote whose URL contains a space", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-spaced-url-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "ssh://git@git.example.test/team repos/app.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.locator.remoteUrl).toBe("ssh://git@git.example.test/team repos/app.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["repo", "repo ", ...lineBreakSuffixes.map((suffix) => `repo${suffix}`)])(
    "returns the git top-level root path when resolving from a nested workspace in %j",
    (rootName) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-nested-root-test-",
        });
        const repoRoot = path.join(tempDir, rootName);
        const nestedWorkspace = path.join(repoRoot, "packages", "web");

        yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
        yield* git(repoRoot, ["init"]);
        yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const identity = yield* resolver.resolve(nestedWorkspace);
        const resolvedIdentityRoot =
          identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
        const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

        expect(identity).not.toBeNull();
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
          normalizeResolvedPath(resolvedRepoRoot),
        );
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(bareLayouts)(
    "resolves a %j to its Git directory and the same identity as a checkout",
    (layout) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkout = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-checkout-",
        });
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-bare-",
        });
        const root = path.join(parent, layout);
        yield* fileSystem.makeDirectory(root);
        const bareGitDir = layout === "dot-bare" ? path.join(root, ".bare") : root;

        yield* git(checkout, ["init"]);
        yield* git(checkout, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
        yield* git(root, ["init", "--bare", bareGitDir]);
        if (layout === "dot-bare") {
          yield* fileSystem.writeFileString(path.join(root, ".git"), "gitdir: ./.bare\n");
        }
        yield* git(root, [
          "--git-dir",
          bareGitDir,
          "remote",
          "add",
          "origin",
          "https://github.com/T3Tools/t3code.git",
        ]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const checkoutIdentity = yield* resolver.resolve(checkout);
        expect(checkoutIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        const resolvedBareGitDir = NodeFS.realpathSync.native(bareGitDir);
        const projectRoots = layout === "dot-bare" ? [root, bareGitDir] : [root];

        for (const projectRoot of projectRoots) {
          const identity = yield* resolver.resolve(projectRoot);
          const resolvedIdentityRoot =
            identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);

          expect(identity).not.toBeNull();
          expect(identity?.canonicalKey).toBe(checkoutIdentity?.canonicalKey);
          expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
            normalizeResolvedPath(resolvedBareGitDir),
          );
        }

        yield* git(root, ["--git-dir", bareGitDir, "remote", "remove", "origin"]);
        for (const projectRoot of projectRoots) {
          expect(yield* resolver.resolve(projectRoot, { refresh: true })).toBeNull();
        }
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["HEAD", "objects", "refs"])(
    "does not inherit a parent repository or report no remote for a bare clone missing %s",
    (entry) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped();
        const bare = path.join(parent, "child.git");
        yield* git(parent, ["init", "--bare", bare]);
        yield* git(bare, [
          "--git-dir=.",
          "remote",
          "add",
          "origin",
          "https://github.com/team/child.git",
        ]);
        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const strict = { refresh: true, onUnavailable: () => Effect.fail("unavailable") };
        expect((yield* resolver.resolve(bare, strict))?.provider).toBe("github");
        yield* fs.rename(path.join(bare, entry), path.join(bare, `${entry}.offline`));
        const standalone = yield* resolver.resolve(bare, strict).pipe(Effect.result);
        yield* git(parent, ["init"]);
        yield* git(parent, ["remote", "add", "origin", "https://git.sankuai.com/team/parent.git"]);
        const nested = yield* resolver.resolve(bare, strict).pipe(Effect.result);
        expect([standalone._tag, nested._tag]).toEqual(["Failure", "Failure"]);
        yield* fs.rename(path.join(bare, `${entry}.offline`), path.join(bare, entry));
        expect((yield* resolver.resolve(bare, strict))?.provider).toBe("github");
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "returns null for non-git, missing and no-remote folders, probing only what can exist",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-non-git-",
        });
        const gitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-no-remote-",
        });

        yield* git(gitDir, ["init"]);

        const runner = yield* ProcessRunner.ProcessRunner;
        const runs: Array<ReadonlyArray<string>> = [];
        const resolver = yield* RepositoryIdentityResolver.make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.suspend(() => {
                runs.push(input.args);
                return runner.run({ ...input, env: { ...input.env, GIT_TRACE: "1" } });
              }),
          }),
        );
        const bareProbes = () =>
          runs.filter((args) => args.some((arg) => arg.startsWith("--git-dir=")));

        expect(yield* resolver.resolve(path.join(nonGitDir, "deleted"))).toBeNull();
        expect(runs).toEqual([]);

        yield* fileSystem.writeFileString(
          path.join(nonGitDir, "config"),
          "ordinary project configuration\n",
        );
        expect(
          yield* resolver.resolve(nonGitDir, { onUnavailable: () => Effect.fail("unavailable") }),
        ).toBeNull();
        expect(bareProbes()).toEqual([]);

        expect(yield* resolver.resolve(gitDir)).toBeNull();
        const ceiling = path.join(gitDir, "projects");
        const plain = path.join(ceiling, "plain");
        yield* fileSystem.makeDirectory(plain, { recursive: true });
        vi.stubEnv("GIT_CEILING_DIRECTORIES", ceiling);
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        const strict = { refresh: true, onUnavailable: () => Effect.fail("unavailable") };
        expect(yield* resolver.resolve(plain, strict)).toBeNull();
        const physicalCeiling = yield* fileSystem.realPath(ceiling);
        vi.stubEnv(
          "GIT_CEILING_DIRECTORIES",
          `${path.sep === "\\" ? ";" : ":"}${physicalCeiling.split(path.sep).join("/")}/`,
        );
        expect(yield* resolver.resolve(plain, strict)).toBeNull();
        yield* fileSystem.makeDirectory(path.join(plain, ".git"));
        const below = path.join(plain, "nested");
        yield* fileSystem.makeDirectory(below);
        expect(yield* resolver.resolve(below, strict).pipe(Effect.flip)).toBe("unavailable");
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("ignores local-path remotes such as GitButler's gb-local", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const localOnlyDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-local-remote-",
      });
      const mixedDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-mixed-remote-",
      });

      yield* git(localOnlyDir, ["init"]);
      yield* git(localOnlyDir, ["remote", "add", "gb-local", "."]);
      yield* git(localOnlyDir, ["remote", "add", "backup", "/srv/git/repo.git"]);
      yield* git(localOnlyDir, ["remote", "add", "archive", "file:///srv/git/repo.git"]);
      yield* git(mixedDir, ["init"]);
      yield* git(mixedDir, ["remote", "add", "gb-local", "."]);
      yield* git(mixedDir, ["remote", "add", "mirror", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve(localOnlyDir)).toBeNull();

      const mixedIdentity = yield* resolver.resolve(mixedDir);
      expect(mixedIdentity?.locator.remoteName).toBe("mirror");
      expect(mixedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(mixedIdentity?.issueRepository).toBeUndefined();
      const backup = { refresh: true, onUnavailable: () => Effect.fail("unavailable") };
      yield* git(mixedDir, ["remote", "rename", "mirror", "upstream"]);
      yield* git(mixedDir, ["remote", "add", "fork", "/srv/git/fork.git"]);
      expect((yield* resolver.resolve(mixedDir, backup))?.issueRepository).toBeNull();
      yield* git(mixedDir, ["remote", "remove", "fork"]);
      yield* git(mixedDir, ["remote", "rename", "upstream", "mirror"]);
      yield* git(mixedDir, ["remote", "add", "origin", "file://127.0.0.1/mirror/fork.git"]);
      const mirrored = yield* resolver.resolve(mixedDir, backup);
      expect(mirrored).toMatchObject({
        canonicalKey: mixedIdentity?.canonicalKey,
        hasLocalOrigin: true,
      });
      expect(mirrored?.origin).toBeUndefined();
      yield* git(mixedDir, ["remote", "remove", "mirror"]);
      expect(yield* resolver.resolve(mixedDir, backup)).toBeNull();
      yield* fileSystem.remove(mixedDir, { recursive: true });
      expect(yield* resolver.resolve(mixedDir, backup).pipe(Effect.flip)).toBe("unavailable");
      expect(yield* resolver.resolve(mixedDir)).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("T3Tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reports a fork's own remote as origin next to the upstream identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-fork-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.origin).toEqual({
        canonicalKey: "github.com/julius/t3code-fork",
        remoteUrl: "git@github.com:julius/t3code-fork.git",
        displayName: "julius/t3code-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the fork as the identity when gh repo set-default points at it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-gh-default-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["config", "remote.origin.gh-resolved", "base"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/julius/t3code-fork");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("follows an OWNER/REPO mark only to a remote that fetches that repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-gh-parent-test-",
      });
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const resolveFresh = () => resolver.resolve(cwd, { refresh: true });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "fork", "https://github.com/julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "main", "https://github.com/T3Tools/t3code.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "https://github.com/other/t3code.git"]);
      yield* git(cwd, ["config", "remote.fork.gh-resolved", "t3tools/t3code"]);
      const parent = yield* resolveFresh();
      expect(parent?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(parent?.locator).toEqual({
        source: "git-remote",
        remoteName: "main",
        remoteUrl: "https://github.com/T3Tools/t3code.git",
      });

      // No remote fetches the marked repository, and several marks leave gh's choice unknown.
      yield* git(cwd, ["config", "remote.fork.gh-resolved", "someone/else"]);
      expect((yield* resolveFresh())?.locator.remoteName).toBe("upstream");
      yield* git(cwd, ["config", "remote.fork.gh-resolved", "base"]);
      yield* git(cwd, ["config", "remote.main.gh-resolved", "base"]);
      expect((yield* resolveFresh())?.locator.remoteName).toBe("upstream");

      // The same path on another HTTPS port is a different server.
      yield* git(cwd, ["config", "--unset", "remote.fork.gh-resolved"]);
      yield* git(cwd, ["config", "--unset", "remote.main.gh-resolved"]);
      yield* git(cwd, ["remote", "add", "backup", "https://ghe.example.com:9443/acme/web.git"]);
      yield* git(cwd, ["remote", "add", "ghe-fork", "https://ghe.example.com:8443/me/web.git"]);
      yield* git(cwd, ["remote", "add", "ghe-parent", "https://ghe.example.com:8443/acme/web.git"]);
      yield* git(cwd, ["config", "remote.ghe-fork.gh-resolved", "acme/web"]);
      expect((yield* resolveFresh())?.locator.remoteName).toBe("ghe-parent");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reads the project's gh default when the server inherited GIT_DIR", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-gh-default-git-dir-",
      });
      const other = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-inherited-git-dir-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["config", "remote.origin.gh-resolved", "base"]);
      yield* git(other, ["init"]);
      yield* git(other, ["config", "remote.upstream.gh-resolved", "base"]);

      vi.stubEnv("GIT_DIR", path.join(other, ".git"));
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/julius/t3code-fork");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("T3Tools/platform/t3code");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
