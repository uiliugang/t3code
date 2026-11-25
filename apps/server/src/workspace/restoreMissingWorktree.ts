import {
  ProjectId,
  ThreadId,
  type Project,
  type TerminalCwdNotFoundError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { isChildWorktree, worktreeMainBranchOnly } from "../git/worktreeBranchPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { scratchFolderRoot } from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";
import * as TaskFolders from "./TaskFolders.ts";
import { TerminalCwdRecovery } from "../terminal/Manager.ts";
import {
  ThreadWorktreeRestore,
  WorktreeMetadataMissingError,
  WorktreeRecreateError,
  WorktreeRecreateNoBaseError,
  type RecreatedWorktree,
  type WorktreeThread,
} from "./ThreadWorktreeRestore.ts";
import { worktreeDependencyEnvironment } from "./worktreeDependencyEnvironment.ts";

export {
  ThreadWorktreeRestore,
  WorktreeMetadataMissingError,
  WorktreeRecreateError,
  WorktreeRecreateNoBaseError,
  type RecreatedWorktree,
  type WorktreeThread,
};

// `git worktree remove` skips pnpm junctions on Windows, leaving these behind without a checkout.
const LEFTOVER_WORKTREE_ENTRIES = new Set(["node_modules", ".next"]);

export const makeRestoreMissingWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const serverConfig = yield* ServerConfig.ServerConfig;

  // Storage cleanup prunes idle No project folders, which have no branch to restore from.
  // An empty folder, only directly inside the No project's own root, lets the thread run again.
  const recreateScratchFolder = Effect.fn("restoreMissingWorktree.recreateScratchFolder")(
    function* (thread: WorktreeThread, folder: string) {
      if (path.resolve(folder) !== folder || (yield* fileSystem.exists(folder))) return;
      const project = Option.getOrUndefined(yield* projects.getById(thread.projectId));
      if (project === undefined || path.dirname(folder) !== path.resolve(project.workspaceRoot))
        return;
      const root = scratchFolderRoot(serverConfig.baseDir, path);
      const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      if (path.dirname(folder) !== root && path.dirname(folder) !== realRoot) return;
      yield* Effect.logWarning("recreating missing scratch folder", {
        threadId: thread.id,
        folder,
      });
      yield* fileSystem.makeDirectory(folder, { recursive: true });
    },
    // Turn start reports a folder that is still missing.
    Effect.orElseSucceed(() => undefined),
  );

  // Only folders holding nothing but leftovers are cleared, never user files.
  const isLeftoverFolder = (worktreePath: string) =>
    fileSystem.exists(path.join(worktreePath, ".git")).pipe(
      Effect.flatMap((hasGit) =>
        hasGit
          ? Effect.succeed(false)
          : fileSystem.readDirectory(worktreePath).pipe(
              Effect.flatMap((entries) =>
                Effect.forEach(entries, (entry) =>
                  LEFTOVER_WORKTREE_ENTRIES.has(entry)
                    ? fileSystem
                        .stat(path.join(worktreePath, entry))
                        .pipe(Effect.map((info) => info.type === "Directory"))
                    : Effect.succeed(false),
                ),
              ),
              Effect.map((leftovers) => leftovers.every(Boolean)),
            ),
      ),
      Effect.orElseSucceed(() => false),
    );
  // `git worktree add` refuses a non-empty target but accepts an empty one. Keep the folder
  // itself: Windows cannot remove a folder that is still a terminal's or provider's cwd.
  const clearLeftovers = (worktreePath: string) =>
    fileSystem
      .readDirectory(worktreePath)
      .pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries,
            (entry) => fileSystem.remove(path.join(worktreePath, entry), { recursive: true }),
            { discard: true },
          ),
        ),
      );
  const taskFolders = yield* TaskFolders.TaskFolders;

  const resolveRecreateBase = Effect.fn("restoreMissingWorktree.resolveRecreateBase")(function* (
    cwd: string,
    remoteName: string | null,
  ) {
    // Recovery can follow an external checkout, before the status cache expires.
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    const remoteHead = `refs/remotes/${remoteName}/HEAD`;
    if (remoteName !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: remoteHead }))) {
      const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: remoteName,
      });
      // Start from the commit so the thread branch does not track the default branch.
      return { refName: commitSha, baseRefName: remoteHead };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
      return { refName: "HEAD", baseRefName: undefined };
    }
    return null;
  });

  const fetchRecreateBase = Effect.fn("restoreMissingWorktree.fetchRecreateBase")(
    (cwd: string, refName: string) =>
      gitWorkflow.fetchWorktreeBaseCommit({ cwd, refName }).pipe(
        // Recovery retains the local base when its remote branch no longer exists.
        Effect.catchTags({
          GitCommandError: (error) =>
            error.reason === "ref_not_found" ? Effect.succeed(null) : Effect.fail(error),
        }),
      ),
  );

  const recreateMissingWorktree = Effect.fn("restoreMissingWorktree.recreate")(function* (input: {
    readonly cwd: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly thread: WorktreeThread;
  }) {
    const { cwd, worktreePath, branch, thread } = input;
    yield* gitWorkflow.pruneWorktrees({ cwd });
    const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
    if (localBranchNames.includes(branch)) {
      yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
      return;
    }
    const { settings } = resolveProjectSettings(
      yield* serverSettings.getSettings,
      thread.projectId,
    );
    const childWorktree = yield* isChildWorktree(thread, projections.findThread);
    const options = { childWorktree, projectId: thread.projectId };
    if (worktreeMainBranchOnly(settings, childWorktree)) {
      const baseRef =
        localBranchNames.find((name) => name === "main") ??
        localBranchNames.find((name) => name === "master") ??
        null;
      if (baseRef === null) {
        return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
      }
      const remoteBase = settings.newWorktreesStartFromOrigin
        ? yield* fetchRecreateBase(cwd, baseRef)
        : null;
      yield* gitWorkflow.createWorktree(
        {
          cwd,
          refName: remoteBase?.commitSha ?? `refs/heads/${baseRef}`,
          newRefName: branch,
          baseRefName: remoteBase
            ? `refs/remotes/${remoteBase.remoteRefName}`
            : `refs/heads/${baseRef}`,
          path: worktreePath,
        },
        options,
      );
      return;
    }
    const remoteName = yield* gitWorkflow
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    // Push keeps the tracking ref current, so recovery reads it without fetching.
    const pushedRef = remoteName === null ? null : `refs/remotes/${remoteName}/${branch}`;
    if (pushedRef !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef }))) {
      yield* gitWorkflow.createWorktree(
        {
          cwd,
          refName: pushedRef,
          newRefName: branch,
          path: worktreePath,
        },
        options,
      );
      return;
    }
    const base = yield* resolveRecreateBase(cwd, remoteName);
    if (base === null) return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
    const remoteBase =
      settings.newWorktreesStartFromOrigin && base.refName.startsWith("refs/heads/")
        ? yield* fetchRecreateBase(cwd, base.refName)
        : null;
    yield* gitWorkflow.createWorktree(
      {
        cwd,
        refName: remoteBase?.commitSha ?? base.refName,
        newRefName: branch,
        ...(remoteBase
          ? { baseRefName: `refs/remotes/${remoteBase.remoteRefName}` }
          : base.baseRefName === undefined
            ? {}
            : { baseRefName: base.baseRefName }),
        path: worktreePath,
      },
      options,
    );
  });

  return Effect.fn("restoreMissingWorktree")(function* (
    thread: WorktreeThread,
    options?: {
      readonly beforeRecreate?: (
        recreated: RecreatedWorktree,
      ) => Effect.Effect<void, WorktreeRecreateError>;
    },
  ) {
    const { worktreePath, branch } = thread;
    if (thread.workspace !== undefined || worktreePath === null) return;
    if (branch === null) return yield* recreateScratchFolder(thread, worktreePath);
    const notifyBeforeRecreate = (project: Project | undefined) =>
      project === undefined || options?.beforeRecreate === undefined
        ? Effect.void
        : options.beforeRecreate({ project, worktreePath });
    // A task folder can miss one repository's worktree while the thread's own folder is there.
    const taskFolder = yield* taskFolders.find(worktreePath).pipe(Effect.orElseSucceed(() => null));
    if (taskFolder !== null) {
      const project = yield* projects.getById(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) => new WorktreeRecreateError({ worktreePath, branch, cause })),
      );
      const restored = yield* taskFolders
        .restore({
          taskFolder,
          branch,
          projectCommands: TaskFolders.linkRunsProjectCommands(thread.linkOrigin),
          beforeRecreate: () => notifyBeforeRecreate(project),
          recreate: (checkout) =>
            Effect.logWarning("recreating missing worktree", {
              threadId: thread.id,
              worktreePath: checkout.worktreePath,
              branch,
            }).pipe(
              Effect.andThen(isLeftoverFolder(checkout.worktreePath)),
              Effect.flatMap((leftover) =>
                leftover ? clearLeftovers(checkout.worktreePath) : Effect.void,
              ),
              Effect.andThen(
                recreateMissingWorktree({
                  cwd: checkout.repositoryPath,
                  worktreePath: checkout.worktreePath,
                  branch,
                  thread,
                }),
              ),
            ),
        })
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "WorktreeRecreateNoBaseError" || cause._tag === "WorktreeRecreateError"
              ? cause
              : new WorktreeRecreateError({ worktreePath, branch, cause }),
          ),
        );
      if (!restored || project === undefined) return;
      return { project, worktreePath };
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (!(yield* isManagedWorktreePath(worktreePath))) return;
    const leftover = exists && (yield* isLeftoverFolder(worktreePath));
    if (exists && !leftover) {
      const hasGit = yield* fileSystem
        .exists(path.join(worktreePath, ".git"))
        .pipe(
          Effect.mapError((cause) => new WorktreeRecreateError({ worktreePath, branch, cause })),
        );
      if (!hasGit) {
        return yield* new WorktreeMetadataMissingError({ worktreePath });
      }
      return;
    }
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new WorktreeRecreateError({ worktreePath, branch, cause })),
    );
    if (project === undefined) return;
    yield* notifyBeforeRecreate(project);
    yield* Effect.logWarning("recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    yield* (leftover ? clearLeftovers(worktreePath) : Effect.void).pipe(
      Effect.andThen(
        recreateMissingWorktree({ cwd: project.workspaceRoot, worktreePath, branch, thread }),
      ),
      Effect.mapError((cause) =>
        cause._tag === "WorktreeRecreateNoBaseError"
          ? cause
          : new WorktreeRecreateError({ worktreePath, branch, cause }),
      ),
    );
    return { project, worktreePath };
  });
});

const PersistedRecreatedEntry = Schema.Struct({
  projectId: ProjectId,
  worktreePath: Schema.String,
  setupCompleted: Schema.optionalKey(Schema.Literal(true)),
});
type PersistedRecreatedEntry = typeof PersistedRecreatedEntry.Type;

const PersistedRecreatedMap = Schema.fromJsonString(
  Schema.Record(Schema.String, PersistedRecreatedEntry),
);
const decodePersistedRecreated = Schema.decodeUnknownEffect(PersistedRecreatedMap);

// Turn start restores under the same lease, so concurrent restores see each other's worktree.
export const layerThreadWorktreeRestore = Layer.effect(
  ThreadWorktreeRestore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const projects = yield* ProjectService.ProjectService;
    const restore = yield* makeRestoreMissingWorktree;
    const stateLock = yield* Semaphore.make(1);
    // Sends, terminals and rollbacks restore before turn start, so turn start runs setup from here.
    const recreated = new Map<ThreadId, RecreatedWorktree>();
    const pendingPath =
      typeof serverConfig.stateDir === "string" && serverConfig.stateDir.length > 0
        ? path.join(serverConfig.stateDir, "recreated-worktree-setup.json")
        : null;
    const persistenceError = (worktreePath: string) => (cause: unknown) =>
      new WorktreeRecreateError({ worktreePath, branch: "", cause });
    const readPersisted = (worktreePathForError = pendingPath ?? "") =>
      pendingPath === null
        ? Effect.succeed({} as Record<string, PersistedRecreatedEntry>)
        : fileSystem.readFileString(pendingPath).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("{}")),
            Effect.flatMap(decodePersistedRecreated),
            Effect.mapError(persistenceError(worktreePathForError)),
          );
    const writePersisted = (
      entries: Record<string, PersistedRecreatedEntry>,
      worktreePathForError: string,
    ) =>
      pendingPath === null
        ? Effect.void
        : (Object.keys(entries).length === 0
            ? fileSystem
                .remove(pendingPath)
                .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void))
            : writeFileStringAtomically({
                filePath: pendingPath,
                contents: `${JSON.stringify(entries, null, 2)}\n`,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              )
          ).pipe(Effect.mapError(persistenceError(worktreePathForError)));
    const persistEntry = (
      threadId: ThreadId,
      projectId: ProjectId,
      worktreePath: string,
      resolved?: RecreatedWorktree,
    ) =>
      stateLock.withPermit(
        Effect.gen(function* () {
          const entries = yield* readPersisted(worktreePath);
          yield* writePersisted(
            { ...entries, [threadId]: { projectId, worktreePath } },
            worktreePath,
          );
          if (resolved !== undefined) recreated.set(threadId, resolved);
        }),
      );
    const clearRecreated = Effect.fn("ThreadWorktreeRestore.clearRecreated")(function* (
      threadId: ThreadId,
      expectedWorktreePath?: string,
      setupCompleted?: true,
    ) {
      yield* stateLock.withPermit(
        Effect.gen(function* () {
          const cached = recreated.get(threadId);
          const targetPath = expectedWorktreePath ?? cached?.worktreePath ?? pendingPath ?? "";
          const cachedMatches =
            cached !== undefined &&
            (expectedWorktreePath === undefined || cached.worktreePath === expectedWorktreePath);
          if (cachedMatches && setupCompleted) {
            recreated.set(threadId, { ...cached, setupCompleted });
          }
          if (pendingPath !== null) {
            const entries = yield* readPersisted(targetPath);
            const persisted = entries[threadId];
            if (
              persisted !== undefined &&
              (expectedWorktreePath === undefined ||
                persisted.worktreePath === expectedWorktreePath)
            ) {
              if (setupCompleted && !persisted.setupCompleted) {
                yield* writePersisted(
                  { ...entries, [threadId]: { ...persisted, setupCompleted } },
                  persisted.worktreePath,
                );
              }
              const next = { ...entries };
              delete next[threadId];
              yield* writePersisted(next, persisted.worktreePath);
            }
          }
          if (cachedMatches) recreated.delete(threadId);
        }),
      );
    });
    const peekRecreated = Effect.fn("ThreadWorktreeRestore.peekRecreated")(function* (
      threadId: ThreadId,
    ) {
      return yield* stateLock.withPermit(
        Effect.gen(function* () {
          const cached = recreated.get(threadId);
          if (cached !== undefined) return cached;
          if (pendingPath === null) return undefined;
          const entries = yield* readPersisted();
          const persisted = entries[threadId];
          if (persisted === undefined) return undefined;
          const project = yield* projects
            .getById(persisted.projectId)
            .pipe(
              Effect.map(Option.getOrUndefined),
              Effect.mapError(persistenceError(persisted.worktreePath)),
            );
          if (project === undefined) {
            const next = { ...entries };
            delete next[threadId];
            yield* writePersisted(next, persisted.worktreePath);
            return undefined;
          }
          const resolved: RecreatedWorktree = {
            project,
            worktreePath: persisted.worktreePath,
            ...(persisted.setupCompleted ? { setupCompleted: true } : {}),
          };
          recreated.set(threadId, resolved);
          return resolved;
        }),
      );
    });
    const recordRecreated = Effect.fn("ThreadWorktreeRestore.recordRecreated")(function* (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly worktreePath: string;
      readonly project?: Project;
    }) {
      const project =
        input.project ??
        (yield* projects
          .getById(input.projectId)
          .pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(persistenceError(input.worktreePath)),
          ));
      yield* persistEntry(
        input.threadId,
        input.projectId,
        input.worktreePath,
        project === undefined ? undefined : { project, worktreePath: input.worktreePath },
      );
    });
    return {
      restore: Effect.fn("ThreadWorktreeRestore.restore")(function* (thread: WorktreeThread) {
        const runRestore = restore(thread, {
          beforeRecreate: (pending) =>
            persistEntry(thread.id, thread.projectId, pending.worktreePath, pending),
        });
        yield* thread.worktreePath === null
          ? runRestore
          : withWorkspaceLease(path.resolve(thread.worktreePath), runRestore);
      }),
      takeRecreated: Effect.fn("ThreadWorktreeRestore.takeRecreated")(function* (
        threadId: ThreadId,
        options?:
          | { readonly action?: "take" | "peek" }
          | {
              readonly action: "clear";
              readonly worktreePath?: string;
              readonly setupCompleted?: true;
            }
          | {
              readonly action: "record";
              readonly projectId: ProjectId;
              readonly worktreePath: string;
              readonly project?: Project;
            },
      ) {
        if (options?.action === "record") {
          yield* recordRecreated({
            threadId,
            projectId: options.projectId,
            worktreePath: options.worktreePath,
            ...(options.project === undefined ? {} : { project: options.project }),
          });
          return undefined;
        }
        if (options?.action === "clear") {
          yield* clearRecreated(threadId, options.worktreePath, options.setupCompleted);
          return undefined;
        }
        const found = yield* peekRecreated(threadId);
        if (found !== undefined && options?.action !== "peek") {
          yield* clearRecreated(threadId, found.worktreePath);
        }
        return found;
      }),
    };
  }),
);

// Worktree setup uses terminals, so recovery must stay outside TerminalManager.
export const makePrepareTerminalLaunch = Effect.fn(
  "restoreMissingWorktree.makePrepareTerminalLaunch",
)(function* <LookupError>(
  getThreadShell: (threadId: ThreadId) => Effect.Effect<WorktreeThread | null, LookupError>,
) {
  const path = yield* Path.Path;
  const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
  const worktreeRestore = yield* Effect.serviceOption(ThreadWorktreeRestore);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("restoreMissingWorktree.prepareTerminalLaunch")(function* <
    Input extends {
      readonly threadId: string;
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | null | undefined;
      readonly env?: Record<string, string> | undefined;
    },
  >(input: Input) {
    const thread = yield* getThreadShell(ThreadId.make(input.threadId)).pipe(
      Effect.orElseSucceed(() => null),
    );
    input = { ...input, env: { ...input.env, T3CODE_PROVIDER_THREAD_ID: thread?.id ?? "" } };
    const worktreePath = thread?.workspace
      ? ((thread.workspace.mode === "isolated"
          ? thread.workspace.resources.find((resource) =>
              isWithinRoot(
                path,
                path.resolve(input.cwd ?? input.worktreePath ?? thread.worktreePath ?? ""),
                resource.checkoutRoot,
              ),
            )?.checkoutRoot
          : null) ?? null)
      : (thread?.worktreePath ?? null);
    if (
      thread === null ||
      worktreePath === null ||
      !isWithinRoot(path, path.resolve(input.cwd ?? worktreePath), worktreePath)
    ) {
      return { input, recover: TerminalCwdRecovery.defaultValue() };
    }
    const settings = yield* serverSettings.getSettings;
    const recover = (error: TerminalCwdNotFoundError) =>
      restoreMissingWorktree(thread, {
        beforeRecreate: (pending) =>
          Option.isNone(worktreeRestore)
            ? Effect.void
            : worktreeRestore.value
                .takeRecreated(thread.id, {
                  action: "record",
                  projectId: thread.projectId,
                  worktreePath: pending.worktreePath,
                  project: pending.project,
                })
                .pipe(Effect.asVoid),
      }).pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logWarning("failed to recreate missing worktree", {
            threadId: thread.id,
            worktreePath,
            cause,
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    // The lease must cover the worktree root, even when the terminal opens in a subdirectory.
    return {
      input: {
        ...input,
        worktreePath,
        env: {
          ...input.env,
          ...worktreeDependencyEnvironment(settings, thread.projectId),
        },
      },
      recover,
    };
  });
});
