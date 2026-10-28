import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import {
  resolveProjectSettings,
  resolveProjectFileBackedSetting,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as ServerSettings from "../serverSettings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Option from "effect/Option";
import {
  CheckpointRef,
  T3_PROJECT_FILE_NAME,
  WorktreeSubmodules,
  ProjectId,
  ProjectWorkspaceConfig,
  ThreadId,
  ThreadWorkspaceRevision,
  WorkspaceExecutionResource,
  WorkspaceRevisionId,
  WorkspaceRootBinding,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

const PreparedResource = Schema.Struct({
  source: WorkspaceExecutionResource,
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  baseCommit: Schema.String,
  baseRef: Schema.String,
  submodules: Schema.NullOr(WorktreeSubmodules),
  submodulesReady: Schema.Boolean,
  resource: Schema.optional(WorkspaceExecutionResource),
  setup: Schema.Literals(["pending", "running", "failed", "done"]),
  ready: Schema.Boolean,
});
export const Preparation = Schema.Struct({
  id: WorkspaceRevisionId,
  threadId: ThreadId,
  projectId: ProjectId,
  config: ProjectWorkspaceConfig,
  mode: Schema.Literals(["existing", "isolated"]),
  bindings: Schema.Array(WorkspaceRootBinding),
  resources: Schema.Array(PreparedResource),
  createdAt: Schema.String,
});
const json = Schema.fromJsonString(Preparation);

export class WorkspacePreparationError extends Schema.TaggedError<WorkspacePreparationError>()(
  "WorkspacePreparationError",
  { threadId: ThreadId, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

export class WorkspaceProvisioner extends Context.Service<
  WorkspaceProvisioner,
  {
    readonly prepare: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly config: ProjectWorkspaceConfig;
      readonly strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
    }) => Effect.Effect<ThreadWorkspaceRevision, WorkspacePreparationError>;
  }
>()("t3/workspace/WorkspaceProvisioner") {}

const isWorkspacePreparationError = Schema.is(WorkspacePreparationError);

export const layer = Layer.effect(
  WorkspaceProvisioner,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const home = yield* HostProcess.HomeDirectory;
    const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const setup = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const save = Effect.fn("WorkspaceProvisioner.save")(function* (state: typeof Preparation.Type) {
      const payload = yield* Schema.encodeEffect(json)(state);
      yield* sql`INSERT INTO workspace_preparations (thread_id, payload_json)
      VALUES (${state.threadId}, ${payload})
      ON CONFLICT(thread_id) DO UPDATE SET payload_json = excluded.payload_json`;
    });

    return WorkspaceProvisioner.of({
      prepare: Effect.fn("WorkspaceProvisioner.prepare")(
        function* (input) {
          return yield* withWorkspaceLease(
            `prepare:${input.threadId}`,
            Effect.gen(function* () {
              const rows = yield* sql<{
                payload_json: string;
              }>`SELECT payload_json FROM workspace_preparations WHERE thread_id = ${input.threadId}`;
              let state: typeof Preparation.Type;
              if (rows[0]) {
                state = yield* Schema.decodeEffect(json)(rows[0].payload_json);
                if (state.projectId !== input.projectId)
                  return yield* new WorkspacePreparationError({
                    threadId: input.threadId,
                    detail: "Workspace preparation belongs to another project.",
                  });
              } else {
                if (input.strategy.type === "existing_worktree")
                  return yield* new WorkspacePreparationError({
                    threadId: input.threadId,
                    detail:
                      "Select the workspace roots or create a complete worktree group. A single existing worktree cannot represent this workspace.",
                  });
                if (
                  input.config.roots.some(
                    (root) => root.defaultSelected && root.accessIntent === "read_only",
                  )
                )
                  return yield* new WorkspacePreparationError({
                    threadId: input.threadId,
                    detail:
                      "Read-only repository roots are not supported by the current providers.",
                  });
                const token = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
                const config = input.config;
                const settings = Option.isSome(settingsService)
                  ? yield* settingsService.value.getSettings
                  : null;
                const worktreesDirectory = resolveWorktreesDirectory(
                  settings?.worktreesDirectory ?? "",
                  serverConfig.worktreesDir,
                  path,
                  home,
                );
                if (worktreesDirectory === null)
                  return yield* new WorkspacePreparationError({
                    threadId: input.threadId,
                    detail: "Set an absolute worktree location on this environment.",
                  });
                const submodules =
                  settings === null
                    ? null
                    : resolveProjectSettings(settings, input.projectId).settings.worktreeSubmodules;
                const launchRoots = [];
                const baseRefs = new Map<string, string>();
                for (const root of config.roots) {
                  let baseRef =
                    root.id === config.primaryRootId && input.strategy.type === "worktree"
                      ? input.strategy.baseRef
                      : (root.defaultBaseRef ?? "HEAD");
                  let recordedBaseRef = baseRef;
                  if (
                    root.defaultSelected &&
                    input.strategy.type === "worktree" &&
                    input.strategy.startFromOrigin
                  ) {
                    const remote = yield* git.fetchWorktreeBaseCommit({
                      cwd: root.sourcePath,
                      refName: baseRef,
                    });
                    if (remote !== null) {
                      baseRef = remote.commitSha;
                      recordedBaseRef = `refs/remotes/${remote.remoteRefName}`;
                    }
                  }
                  baseRefs.set(root.id, recordedBaseRef);
                  launchRoots.push({ ...root, defaultBaseRef: baseRef });
                }
                const resolved = yield* resolver.resolve({ ...config, roots: launchRoots });
                const isolated = input.strategy.type === "worktree";
                const resources = [];
                for (const [index, source] of resolved.resources.entries()) {
                  const binding = resolved.bindings.find((item) => item.resourceId === source.id)!;
                  resources.push({
                    source,
                    path: isolated
                      ? path.join(
                          worktreesDirectory,
                          `workspace-${token}`,
                          `${index + 1}-${source.name}`,
                        )
                      : source.checkoutRoot,
                    branch: isolated
                      ? `${input.strategy.branch ?? `t3-multi-${token}`}${resolved.resources.filter((entry) => entry.storeId === source.storeId).length > 1 ? `-${index + 1}` : ""}`
                      : null,
                    baseCommit: binding.launchBaseCommit!,
                    baseRef: baseRefs.get(binding.rootId)!,
                    submodules,
                    submodulesReady: !isolated,
                    ...(isolated ? {} : { resource: source }),
                    setup: "pending" as const,
                    ready: false,
                  });
                }
                state = {
                  id: WorkspaceRevisionId.make(token),
                  threadId: input.threadId,
                  projectId: input.projectId,
                  config,
                  mode: isolated ? "isolated" : "existing",
                  bindings: resolved.bindings.map((binding) => ({
                    ...binding,
                    launchBaseRef: baseRefs.get(binding.rootId)!,
                  })),
                  resources,
                  createdAt: DateTime.formatIso(yield* DateTime.now),
                };
                yield* save(state);
              }

              for (let index = 0; index < state.resources.length; index++) {
                let item = state.resources[index]!;
                const update = Effect.fn("WorkspaceProvisioner.updateResource")(function* (
                  patch: Partial<typeof item>,
                ) {
                  item = { ...item, ...patch };
                  state = {
                    ...state,
                    resources: state.resources.map((entry, i) => (i === index ? item : entry)),
                  };
                  yield* save(state);
                });
                yield* resolver.verify(item.source.identity);
                if (item.resource === undefined) {
                  yield* fs.makeDirectory(path.dirname(item.path), { recursive: true });
                  if (!(yield* fs.exists(item.path))) {
                    yield* withWorkspaceLease(
                      item.source.identity.commonDir,
                      git.createWorktree(
                        {
                          cwd: item.source.checkoutRoot,
                          refName: item.baseCommit,
                          baseRefName: item.baseRef,
                          newRefName: item.branch!,
                          path: item.path,
                        },
                        { submodules: "none" },
                      ),
                    );
                  }
                  const identity = yield* resolver.inspect(item.path);
                  const branch = (yield* git.execute({
                    operation: "WorkspaceProvisioner.verify",
                    cwd: item.path,
                    args: ["symbolic-ref", "--short", "HEAD"],
                  })).stdout.trim();
                  const head = (yield* git.execute({
                    operation: "WorkspaceProvisioner.verify",
                    cwd: item.path,
                    args: ["rev-parse", "HEAD"],
                  })).stdout.trim();
                  if (
                    identity.commonDir !== item.source.identity.commonDir ||
                    branch !== item.branch ||
                    head !== item.baseCommit
                  )
                    return yield* new WorkspacePreparationError({
                      threadId: input.threadId,
                      detail: `Cannot recover the prepared checkout at ${item.path}; its identity or branch changed.`,
                    });
                  const root = state.config.roots.find((entry) =>
                    state.bindings.some(
                      (binding) =>
                        binding.rootId === entry.id && binding.resourceId === item.source.id,
                    ),
                  )!;
                  const resolved = yield* resolver.resolve({
                    primaryRootId: root.id,
                    roots: [
                      {
                        ...root,
                        sourcePath: item.path,
                        defaultBaseRef: "HEAD",
                        defaultSelected: true,
                      },
                    ],
                  });
                  yield* update({
                    resource: {
                      ...resolved.resources[0]!,
                      name: item.source.name,
                      ownership: "managed",
                    },
                  });
                }
                yield* resolver.verify(item.resource!.identity);
                if (item.ready) continue;
                if (!item.submodulesReady) {
                  const file = yield* fs
                    .readFileString(path.join(item.path, T3_PROJECT_FILE_NAME))
                    .pipe(
                      Effect.map(parseT3ProjectFile),
                      Effect.orElseSucceed(() => null),
                    );
                  const mode = resolveProjectFileBackedSetting(
                    "worktreeSubmodules",
                    item.submodules,
                    file,
                  ).value;
                  if (mode !== "none" && (yield* fs.exists(path.join(item.path, ".gitmodules"))))
                    yield* withWorkspaceLease(
                      item.source.identity.commonDir,
                      git.execute({
                        operation: "WorkspaceProvisioner.submodules",
                        cwd: item.path,
                        args: [
                          "submodule",
                          "update",
                          "--init",
                          ...(mode === "recursive" ? ["--recursive"] : []),
                        ],
                      }),
                    );
                  yield* update({ submodulesReady: true });
                }
                if (item.setup === "running")
                  return yield* new WorkspacePreparationError({
                    threadId: input.threadId,
                    detail: `Setup completion is unknown in ${item.path}. Inspect the setup terminal before retrying; prepared checkouts have been retained.`,
                  });
                if (item.setup !== "done") {
                  const root = state.config.roots.find((entry) =>
                    state.bindings.some(
                      (binding) =>
                        binding.rootId === entry.id && binding.resourceId === item.source.id,
                    ),
                  );
                  if (state.mode === "isolated" && root?.setupScript) {
                    yield* update({ setup: "running" });
                    const result = yield* setup.runForThread({
                      threadId: input.threadId,
                      worktreePath: path.join(
                        item.path,
                        state.bindings.find((binding) => binding.rootId === root.id)!
                          .relativeSubpath,
                      ),
                      project: {
                        id: input.projectId,
                        workspaceRoot: item.source.checkoutRoot,
                        scripts: [
                          {
                            ...root.setupScript,
                            id: `${root.id}-${root.setupScript.id}`,
                            runOnWorktreeCreate: true,
                          },
                        ],
                      },
                      observeCompletion: {},
                    });
                    if (result.status === "started") {
                      const completed =
                        result.completion === undefined ? null : yield* result.completion;
                      if (completed?.exitCode !== 0) {
                        yield* update({
                          setup: completed?.exitCode == null ? "running" : "failed",
                        });
                        return yield* new WorkspacePreparationError({
                          threadId: input.threadId,
                          detail: `Setup failed in ${item.path}; the worktree group was not bound. Prepared repositories are retained for retry.`,
                        });
                      }
                    }
                  }
                  yield* update({ setup: "done" });
                }
                yield* checkpoints.captureCheckpoint({
                  cwd: item.path,
                  checkpointRef: CheckpointRef.make(
                    `refs/t3/workspace-baselines/${state.id}/${index}`,
                  ),
                });
                yield* update({ ready: true });
              }
              const resources = state.resources.map((item) => item.resource!);
              const bindings = [];
              for (const binding of state.bindings) {
                const item = state.resources.find(
                  (entry) => entry.source.id === binding.resourceId,
                )!;
                const branch = yield* git
                  .execute({
                    operation: "WorkspaceProvisioner.branch",
                    cwd: item.path,
                    args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
                  })
                  .pipe(
                    Effect.map((result) => result.stdout.trim()),
                    Effect.orElseSucceed(() => null),
                  );
                bindings.push({
                  ...binding,
                  resourceId: item.resource!.id,
                  executionPath: path.join(item.path, binding.relativeSubpath),
                  launchBranch: branch,
                });
              }
              return ThreadWorkspaceRevision.make({
                id: state.id,
                projectId: state.projectId,
                sourceProjectVersion: state.config.version,
                previousRevisionId: null,
                primaryRootId: state.config.primaryRootId,
                mode: state.mode,
                resources,
                bindings,
                createdAt: state.createdAt,
              });
            }),
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isWorkspacePreparationError(cause)
                ? cause
                : new WorkspacePreparationError({
                    threadId: input.threadId,
                    detail:
                      "Workspace preparation failed. Prepared repositories were retained for retry.",
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
