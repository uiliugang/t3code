import {
  ExecutionResourceId,
  type ProjectWorkspaceConfigInput,
  ProjectScript,
  ProjectWorkspaceRoot,
  RepositoryStoreId,
  WorkspaceCheckoutIdentity,
  type WorkspaceExecutionResource,
  type WorkspaceRootBinding,
  WorkspaceRootId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class WorkspaceRepositoryError extends Schema.TaggedError<WorkspaceRepositoryError>()(
  "WorkspaceRepositoryError",
  {
    path: Schema.String,
    operation: Schema.Literals(["inspect", "resolve-base", "verify-identity"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace repository ${this.operation} failed at '${this.path}'.`;
  }
}

export class WorkspaceRootConflictError extends Schema.TaggedError<WorkspaceRootConflictError>()(
  "WorkspaceRootConflictError",
  {
    rootIds: Schema.Array(WorkspaceRootId),
    reason: Schema.Literals([
      "invalid-selection",
      "incompatible-settings",
      "overlapping-checkouts",
    ]),
  },
) {
  override get message(): string {
    return `Workspace roots cannot be combined (${this.reason}).`;
  }
}

export class WorkspaceRepositoryResolver extends Context.Service<
  WorkspaceRepositoryResolver,
  {
    readonly inspect: (
      cwd: string,
    ) => Effect.Effect<WorkspaceCheckoutIdentity, WorkspaceRepositoryError>;
    readonly verify: (
      identity: WorkspaceCheckoutIdentity,
    ) => Effect.Effect<void, WorkspaceRepositoryError>;
    readonly verifyRepository: (
      identity: WorkspaceCheckoutIdentity,
    ) => Effect.Effect<void, WorkspaceRepositoryError>;
    readonly resolve: (
      config: ProjectWorkspaceConfigInput,
      selectedRootIds?: ReadonlyArray<WorkspaceRootId>,
    ) => Effect.Effect<
      {
        readonly primaryRootId: WorkspaceRootId;
        readonly resources: ReadonlyArray<WorkspaceExecutionResource>;
        readonly bindings: ReadonlyArray<WorkspaceRootBinding>;
      },
      WorkspaceRepositoryError | WorkspaceRootConflictError
    >;
  }
>()("t3/workspace/WorkspaceRepositoryResolver") {}

const encodeIdentityParts = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const sameIdentity = Schema.toEquivalence(WorkspaceCheckoutIdentity);
const RepositorySettings = Schema.Struct({
  accessIntent: ProjectWorkspaceRoot.fields.accessIntent,
  baseCommit: Schema.String,
  setupScript: Schema.NullOr(ProjectScript),
});
const sameSettings = Schema.toEquivalence(RepositorySettings);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const crypto = yield* Crypto.Crypto;
  const identityHash = Effect.fn("WorkspaceRepositoryResolver.identityHash")(function* (
    parts: ReadonlyArray<string>,
  ) {
    return Hex.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(encodeIdentityParts(parts)))
        .pipe(Effect.orDie),
    );
  });

  const directoryIdentity = Effect.fn("WorkspaceRepositoryResolver.directoryIdentity")(function* (
    directory: string,
  ) {
    const info = yield* fs.stat(directory);
    const ino = Option.getOrNull(info.ino);
    const birthtime = Option.getOrNull(info.birthtime)?.getTime() ?? null;
    if (ino === null && birthtime === null) {
      return yield* new WorkspaceRepositoryError({
        path: directory,
        operation: "inspect",
        cause: "The filesystem does not expose directory identity.",
      });
    }
    return encodeIdentityParts([String(info.dev), String(ino), String(birthtime)]);
  });

  const inspect = Effect.fn("WorkspaceRepositoryResolver.inspect")(
    function* (cwd: string) {
      const realCwd = yield* fs.realPath(cwd);
      const values = yield* Effect.forEach(
        [
          ["rev-parse", "--show-toplevel"],
          ["rev-parse", "--absolute-git-dir"],
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ],
        (args) =>
          git
            .execute({ operation: "WorkspaceRepositoryResolver.inspect", cwd: realCwd, args })
            .pipe(Effect.flatMap((result) => fs.realPath(result.stdout.replace(/\r?\n$/, "")))),
      );
      const [checkoutRoot, gitDir, commonDir] = values;
      if (!checkoutRoot || !gitDir || !commonDir) {
        return yield* new WorkspaceRepositoryError({
          path: cwd,
          operation: "inspect",
          cause: "Git returned an incomplete checkout identity.",
        });
      }
      return {
        checkoutRoot,
        gitDir,
        commonDir,
        gitDirIdentity: yield* directoryIdentity(gitDir),
        commonDirIdentity: yield* directoryIdentity(commonDir),
      } satisfies WorkspaceCheckoutIdentity;
    },
    (effect, cwd) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isWorkspaceRepositoryError(cause)
            ? cause
            : new WorkspaceRepositoryError({ path: cwd, operation: "inspect", cause }),
        ),
      ),
  );

  const verify = Effect.fn("WorkspaceRepositoryResolver.verify")(function* (
    identity: WorkspaceCheckoutIdentity,
  ) {
    const current = yield* inspect(identity.checkoutRoot);
    if (!sameIdentity(current, identity)) {
      return yield* new WorkspaceRepositoryError({
        path: identity.checkoutRoot,
        operation: "verify-identity",
        cause: "The checkout was replaced or moved.",
      });
    }
  });

  const resolve = Effect.fn("WorkspaceRepositoryResolver.resolve")(function* (
    config: ProjectWorkspaceConfigInput,
    selectedRootIds?: ReadonlyArray<WorkspaceRootId>,
  ) {
    const selected = new Set(
      selectedRootIds ?? config.roots.filter((root) => root.defaultSelected).map((root) => root.id),
    );
    if (
      !selected.has(config.primaryRootId) ||
      [...selected].some((id) => !config.roots.some((root) => root.id === id))
    ) {
      return yield* new WorkspaceRootConflictError({
        rootIds: [...selected],
        reason: "invalid-selection",
      });
    }
    const roots = config.roots.filter((root) => selected.has(root.id));
    const resources = new Map<ExecutionResourceId, WorkspaceExecutionResource>();
    const settings = new Map<ExecutionResourceId, typeof RepositorySettings.Type>();
    const bindings: Array<WorkspaceRootBinding> = [];
    for (const root of roots) {
      const identity = yield* inspect(root.sourcePath);
      const sourcePath = yield* fs
        .realPath(root.sourcePath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceRepositoryError({ path: root.sourcePath, operation: "inspect", cause }),
          ),
        );
      const id = ExecutionResourceId.make(
        `checkout:${yield* identityHash([identity.gitDir, identity.gitDirIdentity])}`,
      );
      const baseRef = root.defaultBaseRef ?? "HEAD";
      const launchBaseCommit = yield* git
        .execute({
          operation: "WorkspaceRepositoryResolver.resolveBase",
          cwd: sourcePath,
          args: ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
        })
        .pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.mapError(
            (cause) =>
              new WorkspaceRepositoryError({ path: sourcePath, operation: "resolve-base", cause }),
          ),
        );
      const policy = {
        accessIntent: root.accessIntent,
        baseCommit: launchBaseCommit,
        setupScript: root.setupScript ?? null,
      };
      const previousSettings = settings.get(id);
      if (previousSettings !== undefined && !sameSettings(previousSettings, policy)) {
        return yield* new WorkspaceRootConflictError({
          rootIds: [
            ...bindings
              .filter((binding) => binding.resourceId === id)
              .map((binding) => binding.rootId),
            root.id,
          ],
          reason: "incompatible-settings",
        });
      }
      settings.set(id, policy);
      resources.set(id, {
        id,
        storeId: RepositoryStoreId.make(
          `git:${yield* identityHash([identity.commonDir, identity.commonDirIdentity])}`,
        ),
        name: path.basename(identity.checkoutRoot),
        checkoutRoot: identity.checkoutRoot,
        identity,
        ownership: "borrowed",
        generation: 1,
      });
      bindings.push({
        rootId: root.id,
        alias: root.alias,
        description: root.description,
        accessIntent: root.accessIntent,
        resourceId: id,
        relativeSubpath: path.relative(identity.checkoutRoot, sourcePath),
        sourcePathAtBind: sourcePath,
        executionPath: sourcePath,
        launchBaseRef: baseRef,
        launchBaseCommit,
        launchBranch: null,
      });
    }
    const resolved = [...resources.values()];
    for (const resource of resolved) {
      for (const other of resolved) {
        if (resource.id === other.id) continue;
        const relative = path.relative(resource.checkoutRoot, other.checkoutRoot);
        if (
          relative === "" ||
          (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        ) {
          return yield* new WorkspaceRootConflictError({
            rootIds: bindings
              .filter(
                (binding) => binding.resourceId === resource.id || binding.resourceId === other.id,
              )
              .map((binding) => binding.rootId),
            reason: "overlapping-checkouts",
          });
        }
      }
    }
    return { primaryRootId: config.primaryRootId, resources: resolved, bindings };
  });

  const verifyRepository = Effect.fn("WorkspaceRepositoryResolver.verifyRepository")(
    function* (identity: WorkspaceCheckoutIdentity) {
      if (
        (yield* fs.realPath(identity.commonDir)) !== identity.commonDir ||
        (yield* directoryIdentity(identity.commonDir)) !== identity.commonDirIdentity
      )
        return yield* new WorkspaceRepositoryError({
          path: identity.commonDir,
          operation: "verify-identity",
          cause: "The source repository was replaced or moved.",
        });
    },
    (effect, identity) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isWorkspaceRepositoryError(cause)
            ? cause
            : new WorkspaceRepositoryError({
                path: identity.commonDir,
                operation: "verify-identity",
                cause,
              }),
        ),
      ),
  );
  return WorkspaceRepositoryResolver.of({ inspect, verify, verifyRepository, resolve });
});

const isWorkspaceRepositoryError = Schema.is(WorkspaceRepositoryError);

export const layer = Layer.effect(WorkspaceRepositoryResolver, make);
