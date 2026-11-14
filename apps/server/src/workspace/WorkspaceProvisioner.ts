import {
  resolveProjectScripts,
  setupProjectScript,
  projectScriptAppliesToRoots,
} from "@t3tools/shared/projectScripts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import {
  resolveProjectSettings,
  resolveProjectFileBackedSetting,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { isMainOrMasterBranch, isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as ServerSettings from "../serverSettings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Option from "effect/Option";
import {
  CheckpointRef,
  GitCommandError,
  T3_PROJECT_FILE_NAME,
  WorktreeSubmodules,
  ProjectId,
  type ProjectScript,
  ProjectWorkspaceConfig,
  ThreadId,
  ThreadWorkspaceRevision,
  WorkspaceExecutionResource,
  WorkspaceRevisionId,
  WorkspaceRootBinding,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";
import { sameDirectoryIdentity } from "./directoryIdentity.ts";

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
  generatedBranchName: Schema.optional(
    Schema.Struct({ branch: Schema.String, exactName: Schema.Boolean }),
  ),
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
      readonly scripts?: readonly ProjectScript[];
      readonly strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
      readonly generatedBranchName?: GitVcsDriver.CreateWorktreeOptions["generatedBranchName"];
    }) => Effect.Effect<
      {
        readonly workspace: ThreadWorkspaceRevision;
        readonly completion: Effect.Effect<void, WorkspacePreparationError>;
        readonly cancel: Effect.Effect<void>;
      },
      WorkspacePreparationError | GitCommandError
    >;
  }
>()("t3/workspace/WorkspaceProvisioner") {}

const isWorkspacePreparationError = Schema.is(WorkspacePreparationError);
const isGitCommandError = Schema.is(GitCommandError);

export const layer = Layer.effect(
  WorkspaceProvisioner,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const home = yield* HostProcess.HomeDirectory;
    const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const setup = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
    const terminals = yield* TerminalManager.TerminalManager;
    const save = Effect.fn("WorkspaceProvisioner.save")(function* (state: typeof Preparation.Type) {
      const payload = yield* Schema.encodeEffect(json)(state);
      yield* sql`INSERT INTO workspace_preparations (thread_id, payload_json)
      VALUES (${state.threadId}, ${payload})
      ON CONFLICT(thread_id) DO UPDATE SET payload_json = excluded.payload_json`;
    });

    return WorkspaceProvisioner.of({
      prepare: Effect.fn("WorkspaceProvisioner.prepare")(
        function* (input) {
          const terminalIds: string[] = [];
          return yield* withWorkspaceLease(
            `prepare:${input.threadId}`,
            Effect.gen(function* () {
              const rows = yield* sql<{
                payload_json: string;
              }>`SELECT payload_json FROM workspace_preparations WHERE thread_id = ${input.threadId}`;
              const settings = Option.isSome(settingsService)
                ? yield* settingsService.value.getSettings
                : null;
              let state: typeof Preparation.Type;
              if (rows[0]) {
                state = yield* Schema.decodeEffect(json)(rows[0].payload_json);
                if (state.projectId !== input.projectId)
                  return yield* new WorkspacePreparationError({
                    threadId: input.threadId,
                    detail: "Workspace preparation belongs to another project.",
                  });
              } else {
                yield* tracker.stageStatus(input.threadId, "fetch", "running");
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
                const token = yield* random.uuidV4().pipe(Effect.orDie);
                const workspaceSetup = settings
                  ? setupProjectScript(
                      resolveProjectScripts(settings, {
                        id: input.projectId,
                        scripts: input.scripts ?? [],
                      }),
                    )
                  : null;
                const config = workspaceSetup
                  ? {
                      ...input.config,
                      roots: input.config.roots.map(({ setupScript: _setup, ...root }) => ({
                        ...root,
                        ...(projectScriptAppliesToRoots(workspaceSetup, [root.id])
                          ? { setupScript: workspaceSetup }
                          : {}),
                      })),
                    }
                  : input.config;
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
                const projectSettings =
                  settings === null
                    ? null
                    : resolveProjectSettings(settings, input.projectId).settings;
                const submodules = projectSettings?.worktreeSubmodules ?? null;
                const launchRoots = [];
                const baseRefs = new Map<string, string>();
                for (const root of config.roots) {
                  const taskBranch =
                    root.defaultSelected && input.strategy.type === "root"
                      ? yield* git.prepareTaskBranch({
                          cwd: root.sourcePath,
                          branch: `t3/${token.slice(0, 8)}`,
                          startFromOrigin: projectSettings?.newWorktreesStartFromOrigin ?? true,
                        })
                      : null;
                  let baseRef =
                    root.id === config.primaryRootId && input.strategy.type === "worktree"
                      ? input.strategy.baseRef
                      : (taskBranch?.branch ?? root.defaultBaseRef ?? "HEAD");
                  if (
                    root.defaultSelected &&
                    input.strategy.type === "worktree" &&
                    projectSettings?.newWorktreesMainBranchOnly
                  ) {
                    if (baseRef === "HEAD" && root.defaultBaseRef === undefined) {
                      const branches = yield* git.listLocalBranchNames(root.sourcePath);
                      baseRef =
                        branches.find((name) => name === "main") ??
                        branches.find((name) => name === "master") ??
                        baseRef;
                    }
                    const resolvedBase = yield* git.execute({
                      operation: "WorkspaceProvisioner.validateBase",
                      cwd: root.sourcePath,
                      args: [
                        "rev-parse",
                        "--symbolic-full-name",
                        "--verify",
                        "--end-of-options",
                        baseRef,
                      ],
                    });
                    if (!isMainOrMasterBranch(resolvedBase.stdout.trim()))
                      return yield* new WorkspacePreparationError({
                        threadId: input.threadId,
                        detail: `${root.alias}: new worktree branches must start from main or master. Change this in Settings → Source Control → Branch management.`,
                      });
                  }
                  let recordedBaseRef = baseRef;
                  if (
                    root.defaultSelected &&
                    input.strategy.type === "worktree" &&
                    (input.strategy.startFromOrigin ??
                      projectSettings?.newWorktreesStartFromOrigin ??
                      true)
                  ) {
                    const remote = yield* git
                      .fetchWorktreeBaseCommit({
                        cwd: root.sourcePath,
                        refName: baseRef,
                      })
                      .pipe(
                        Effect.tapError((error) =>
                          tracker.stageStatus(input.threadId, "fetch", "failed", error.detail),
                        ),
                      );
                    if (remote !== null) {
                      baseRef = remote.commitSha;
                      recordedBaseRef = `refs/remotes/${remote.remoteRefName}`;
                    }
                  }
                  baseRefs.set(root.id, recordedBaseRef);
                  launchRoots.push({ ...root, defaultBaseRef: baseRef });
                }
                let resolved = yield* resolver.resolve({ ...config, roots: launchRoots });
                let existingIsolated = false;
                if (input.strategy.type === "existing_worktree") {
                  if (resolved.resources.length !== 1)
                    return yield* new WorkspacePreparationError({
                      threadId: input.threadId,
                      detail:
                        "Select the workspace roots or create a complete worktree group. A single existing worktree cannot represent this workspace.",
                    });
                  const checkout = yield* resolver.inspect(input.strategy.worktreePath);
                  const source = resolved.resources[0]!.identity;
                  if (
                    checkout.commonDir !== source.commonDir ||
                    !sameDirectoryIdentity(
                      checkout.commonDirIdentity,
                      source.commonDirIdentity,
                      platform,
                    )
                  )
                    return yield* new WorkspacePreparationError({
                      threadId: input.threadId,
                      detail: "The selected checkout belongs to another repository.",
                    });
                  if (
                    input.strategy.branch !== undefined &&
                    (yield* git.resolveBranchName(checkout.checkoutRoot, "HEAD")) !==
                      input.strategy.branch
                  )
                    return yield* new WorkspacePreparationError({
                      threadId: input.threadId,
                      detail: "The selected checkout branch changed. Prepare the checkout again.",
                    });
                  const selected = yield* resolver.resolve({
                    primaryRootId: config.primaryRootId,
                    roots: config.roots.map((root) => {
                      const binding = resolved.bindings.find((item) => item.rootId === root.id);
                      return binding
                        ? {
                            ...root,
                            sourcePath: path.join(checkout.checkoutRoot, binding.relativeSubpath),
                            defaultBaseRef: "HEAD",
                          }
                        : root;
                    }),
                  });
                  existingIsolated = checkout.checkoutRoot !== source.checkoutRoot;
                  const sourceBindings = resolved.bindings;
                  resolved = {
                    ...selected,
                    bindings: selected.bindings.map((binding) => ({
                      ...binding,
                      sourcePathAtBind: sourceBindings.find(
                        (item) => item.rootId === binding.rootId,
                      )!.sourcePathAtBind,
                    })),
                  };
                  for (const binding of resolved.bindings) baseRefs.set(binding.rootId, "HEAD");
                }
                const isolated = input.strategy.type === "worktree";
                const generatedBranchName =
                  isolated &&
                  (input.strategy.branch === undefined ||
                    isTemporaryWorktreeBranch(input.strategy.branch))
                    ? input.generatedBranchName
                    : undefined;
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
                    setup:
                      input.strategy.type === "existing_worktree"
                        ? ("done" as const)
                        : ("pending" as const),
                    ready: false,
                  });
                }
                state = {
                  id: WorkspaceRevisionId.make(token),
                  threadId: input.threadId,
                  projectId: input.projectId,
                  config,
                  mode: isolated || existingIsolated ? "isolated" : "existing",
                  ...(generatedBranchName === undefined ? {} : { generatedBranchName }),
                  bindings: resolved.bindings.map((binding) => ({
                    ...binding,
                    launchBaseRef: baseRefs.get(binding.rootId)!,
                  })),
                  resources,
                  createdAt: DateTime.formatIso(yield* DateTime.now),
                };
                yield* save(state);
              }

              yield* tracker.stageStatus(input.threadId, "fetch", "done");
              const update = Effect.fn("WorkspaceProvisioner.updateResource")(function* (
                index: number,
                patch: Partial<typeof PreparedResource.Type>,
              ) {
                const item = { ...state.resources[index]!, ...patch };
                state = {
                  ...state,
                  resources: state.resources.map((entry, i) => (i === index ? item : entry)),
                };
                yield* save(state);
                return item;
              });
              yield* tracker.stageStatus(input.threadId, "checkout", "running");
              for (let index = 0; index < state.resources.length; index++) {
                let item = state.resources[index]!;
                yield* resolver.verify(item.source.identity);
                if (item.resource === undefined) {
                  yield* fs.makeDirectory(path.dirname(item.path), { recursive: true });
                  if (!(yield* fs.exists(item.path))) {
                    const created = yield* withWorkspaceLease(
                      item.source.identity.commonDir,
                      git.createWorktree(
                        {
                          cwd: item.source.checkoutRoot,
                          refName: item.baseCommit,
                          baseRefName: item.baseRef,
                          newRefName: item.branch!,
                          path: item.path,
                        },
                        {
                          submodules: "none",
                          fastCheckout: settings?.fastWorktreeCheckout ?? false,
                          ...(state.generatedBranchName === undefined
                            ? {}
                            : { generatedBranchName: state.generatedBranchName }),
                        },
                      ),
                    );
                    item = yield* update(index, { branch: created.worktree.refName });
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
                  item = yield* update(index, {
                    resource: {
                      ...resolved.resources[0]!,
                      name: item.source.name,
                      ownership: "managed",
                    },
                  });
                }
                yield* resolver.verify(item.resource!.identity);
              }
              yield* tracker.stageStatus(input.threadId, "checkout", "done");
              let initializedSubmodules = false;
              for (let index = 0; index < state.resources.length; index++) {
                let item = state.resources[index]!;
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
                  if (mode !== "none" && (yield* fs.exists(path.join(item.path, ".gitmodules")))) {
                    initializedSubmodules = true;
                    yield* tracker.stageStatus(input.threadId, "submodules", "running");
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
                  }
                  item = yield* update(index, { submodulesReady: true });
                }
                if (item.setup === "running")
                  return yield* new WorkspacePreparationError({
                    threadId: input.threadId,
                    detail: `Setup completion is unknown in ${item.path}. Inspect the setup terminal before retrying; prepared checkouts have been retained.`,
                  });
              }
              yield* tracker.stageStatus(
                input.threadId,
                "submodules",
                initializedSubmodules ? "done" : "skipped",
              );
              const completions: Array<Effect.Effect<void, WorkspacePreparationError>> = [];
              const scripts = state.resources.map((item, index) => ({
                index,
                root:
                  state.mode === "isolated" && !item.ready && item.setup !== "done"
                    ? state.config.roots.find(
                        (entry) =>
                          entry.setupScript &&
                          projectScriptAppliesToRoots(entry.setupScript, [entry.id]) &&
                          state.bindings.some(
                            (binding) =>
                              binding.rootId === entry.id && binding.resourceId === item.source.id,
                          ),
                      )
                    : undefined,
              }));
              const runSetup = Effect.fn("WorkspaceProvisioner.runSetup")(function* (
                index: number,
                root: (typeof state.config.roots)[number],
              ) {
                const item = yield* update(index, { setup: "running" });
                yield* tracker.stageStatus(input.threadId, "setup-script", "running");
                const result = yield* setup.runForThread({
                  threadId: input.threadId,
                  repositoryRootIds: [root.id],
                  script: { ...root.setupScript!, id: `${root.id}-${root.setupScript!.id}` },
                  worktreePath: path.join(
                    item.path,
                    state.bindings.find((binding) => binding.rootId === root.id)!.relativeSubpath,
                  ),
                  project: {
                    id: input.projectId,
                    workspaceRoot: item.source.checkoutRoot,
                    scripts: [
                      {
                        ...root.setupScript!,
                        id: `${root.id}-${root.setupScript!.id}`,
                        runOnWorktreeCreate: true,
                      },
                    ],
                  },
                  observeCompletion: {
                    onOutputLine: (line) =>
                      tracker.appendTail(input.threadId, "setup-script", line),
                  },
                });
                if (result.status === "started") {
                  terminalIds.push(result.terminalId);
                  yield* tracker.update(input.threadId, (snapshot) => ({
                    ...snapshot,
                    setupScript: {
                      name: result.scriptName,
                      command: result.scriptCommand,
                      terminalId: result.terminalId,
                    },
                  }));
                  const complete = Effect.gen(function* () {
                    const completed =
                      result.completion === undefined ? null : yield* result.completion;
                    yield* tracker.appendTail(
                      input.threadId,
                      "setup-script",
                      `${root.alias}: exited with ${completed?.exitCode ?? "no exit code"}`,
                    );
                    if (completed?.exitCode !== 0) {
                      yield* update(index, {
                        setup: completed?.exitCode == null ? "running" : "failed",
                      });
                      return yield* new WorkspacePreparationError({
                        threadId: input.threadId,
                        detail: result.async
                          ? `Setup failed in ${item.path}; inspect the setup terminal. The agent has already been released.`
                          : `Setup failed in ${item.path}; the worktree group was not bound. Prepared repositories are retained for retry.`,
                      });
                    }
                    yield* update(index, { setup: "done" });
                  }).pipe(
                    Effect.mapError((cause) =>
                      isWorkspacePreparationError(cause)
                        ? cause
                        : new WorkspacePreparationError({
                            threadId: input.threadId,
                            detail: "Could not record setup completion.",
                            cause,
                          }),
                    ),
                  );
                  if (result.async) completions.push(complete);
                  else yield* complete;
                } else {
                  yield* update(index, { setup: "done" });
                }
              });
              for (const { index, root } of scripts) {
                if (root?.setupScript?.async === false) yield* runSetup(index, root);
              }
              if (
                !scripts.some(({ root }) => root?.setupScript && root.setupScript.async !== false)
              )
                yield* tracker.stageStatus(
                  input.threadId,
                  "setup-script",
                  scripts.some(({ root }) => root?.setupScript) ? "done" : "skipped",
                );
              yield* tracker.stageStatus(input.threadId, "baseline", "running");
              for (const [index, item] of state.resources.entries()) {
                if (item.ready) continue;
                yield* checkpoints.captureCheckpoint({
                  cwd: item.path,
                  checkpointRef: CheckpointRef.make(
                    `refs/t3/workspace-baselines/${state.id}/${index}`,
                  ),
                });
              }
              yield* tracker.stageStatus(input.threadId, "baseline", "done");
              for (const { index, root } of scripts) {
                if (root?.setupScript && root.setupScript.async !== false)
                  yield* runSetup(index, root);
                const item = state.resources[index]!;
                if (!item.ready)
                  yield* update(index, {
                    ready: true,
                    ...(item.setup === "pending" ? { setup: "done" as const } : {}),
                  });
              }
              if (completions.length === 0)
                yield* tracker.stageStatus(
                  input.threadId,
                  "setup-script",
                  scripts.some(({ root }) => root?.setupScript) ? "done" : "skipped",
                );
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
              const workspace = ThreadWorkspaceRevision.make({
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
              const primary = bindings.find(
                (binding) => binding.rootId === state.config.primaryRootId,
              );
              yield* tracker.update(input.threadId, (snapshot) => ({
                ...snapshot,
                worktreePath: primary?.executionPath ?? null,
                branch: primary?.launchBranch ?? null,
              }));
              const cancel = Effect.forEach(
                terminalIds,
                (terminalId) =>
                  terminals
                    .close({ threadId: input.threadId, terminalId, deleteHistory: true })
                    .pipe(Effect.ignore),
                { discard: true },
              );
              return {
                workspace,
                cancel,
                completion: Effect.gen(function* () {
                  let failure: WorkspacePreparationError | undefined;
                  yield* Effect.forEach(
                    completions,
                    (completion) =>
                      completion.pipe(
                        Effect.catch((error) => {
                          failure ??= error;
                          return tracker.stageStatus(
                            input.threadId,
                            "setup-script",
                            "failed",
                            error.detail,
                          );
                        }),
                      ),
                    { discard: true },
                  );
                  if (failure) return yield* failure;
                  if (completions.length > 0)
                    yield* tracker.stageStatus(input.threadId, "setup-script", "done");
                }),
              };
            }),
          ).pipe(
            Effect.onError((cause) =>
              Effect.forEach(
                terminalIds,
                (terminalId) =>
                  terminals
                    .close({
                      threadId: input.threadId,
                      terminalId,
                      deleteHistory: Cause.hasInterruptsOnly(cause),
                    })
                    .pipe(Effect.ignore),
                { discard: true },
              ),
            ),
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isWorkspacePreparationError(cause) || isGitCommandError(cause)
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
