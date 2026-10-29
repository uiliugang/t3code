import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProjectWorkspaceRoot, WorkspaceRootId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";

const layerTest = WorkspaceRepositoryResolver.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-repositories-" })),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const root = (id: string, sourcePath: string): ProjectWorkspaceRoot => ({
  id: WorkspaceRootId.make(id),
  alias: id,
  sourcePath,
  description: "",
  defaultSelected: true,
  accessIntent: "write",
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-repositories-" });
  const cwd = path.join(temp, "repo");
  yield* fs.makeDirectory(path.join(cwd, "src"), { recursive: true });
  const run = (dir: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "WorkspaceRepositoryResolver.test", cwd: dir, args });
  yield* run(cwd, ["init", "-b", "main"]);
  yield* run(cwd, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  return {
    fs,
    path,
    cwd,
    temp,
    run,
    resolver: yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver,
  };
});

it.live("deduplicates one checkout's subdirectories and rejects incompatible access or setup", () =>
  Effect.gen(function* () {
    const { resolver, cwd, path } = yield* fixture;
    const primary = root("app", cwd);
    const secondary = root("source", path.join(cwd, "src"));
    const config = { primaryRootId: primary.id, roots: [primary, secondary] };
    const workspace = yield* resolver.resolve(config);
    assert.lengthOf(workspace.resources, 1);
    assert.lengthOf(workspace.bindings, 2);
    assert.equal(workspace.bindings[1]?.relativeSubpath, "src");
    assert.equal(workspace.bindings[0]?.resourceId, workspace.bindings[1]?.resourceId);
    for (const conflicting of [
      { ...secondary, accessIntent: "read_only" as const },
      {
        ...secondary,
        setupScript: {
          id: "setup",
          name: "Setup",
          command: "install",
          icon: "configure" as const,
          runOnWorktreeCreate: true,
        },
      },
    ]) {
      const error = yield* resolver
        .resolve({ ...config, roots: [primary, conflicting] })
        .pipe(Effect.flip);
      assert.instanceOf(error, WorkspaceRepositoryResolver.WorkspaceRootConflictError);
    }
    const invalid = yield* resolver.resolve(config, [secondary.id]).pipe(Effect.flip);
    assert.equal(invalid._tag, "WorkspaceRootConflictError");
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.live("distinguishes clones and worktrees while retaining shared Git store identity", () =>
  Effect.gen(function* () {
    const { resolver, cwd, temp, fs, path, run } = yield* fixture;
    const clone = path.join(temp, "clone", "repo");
    const worktree = path.join(temp, "worktree");
    yield* fs.makeDirectory(path.dirname(clone));
    yield* run(temp, ["clone", cwd, clone]);
    yield* run(cwd, ["worktree", "add", "--detach", worktree, "HEAD"]);
    const primary = root("original", cwd);
    const workspace = yield* resolver.resolve({
      primaryRootId: primary.id,
      roots: [primary, root("clone", clone), root("worktree", worktree)],
    });
    assert.equal(new Set(workspace.resources.map((resource) => resource.id)).size, 3);
    assert.equal(workspace.resources[0]?.storeId, workspace.resources[2]?.storeId);
    assert.notEqual(workspace.resources[0]?.storeId, workspace.resources[1]?.storeId);
    assert.equal(workspace.resources[0]?.name, workspace.resources[1]?.name);
    const identity = yield* resolver.inspect(cwd);
    yield* resolver.verify(identity);
    yield* fs.rename(path.join(cwd, ".git"), path.join(temp, "original-git"));
    yield* run(cwd, ["init"]);
    const replaced = yield* resolver.verify(identity).pipe(Effect.flip);
    assert.equal(replaced.operation, "verify-identity");
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.live("rejects nested independent repositories before preparing worktrees", () =>
  Effect.gen(function* () {
    const { resolver, cwd, path, run } = yield* fixture;
    const nested = path.join(cwd, "src");
    yield* run(nested, ["init"]);
    yield* run(nested, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "nested",
    ]);
    const primary = root("parent", cwd);
    const error = yield* resolver
      .resolve({ primaryRootId: primary.id, roots: [primary, root("nested", nested)] })
      .pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceRootConflictError");
    if (error._tag === "WorkspaceRootConflictError")
      assert.equal(error.reason, "overlapping-checkouts");
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
