import {
  CommandId,
  ManagedWorktreeError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
  ThreadId,
  ThreadWorkspaceRevision,
  WorkspaceCheckoutIdentity,
  WorkspaceRevisionId,
  type ManagedWorktreeGroup,
  type ManagedWorktreeResult,
  type ManagedWorktreesListInput,
  type ManagedWorktreesRemoveInput,
  type ManagedWorktreesRestoreInput,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { removeLinkedWorktree } from "../vcs/worktreeRemoval.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import { withWorkspaceLeases } from "./workspaceLease.ts";

const SavedResource = Schema.Struct({
  identity: WorkspaceCheckoutIdentity,
  branch: Schema.NullOr(Schema.String),
  commit: Schema.String,
  ref: Schema.String,
  removed: Schema.Boolean,
  restoredIdentity: Schema.optional(WorkspaceCheckoutIdentity),
});
const Snapshot = Schema.Struct({
  id: Schema.String,
  threads: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      workspace: Schema.optional(ThreadWorkspaceRevision),
      restoredWorkspace: Schema.optional(ThreadWorkspaceRevision),
    }),
  ),
  resources: Schema.Array(SavedResource),
});
type Snapshot = typeof Snapshot.Type;
type CleanupThread = OrchestrationV2AppThreadJson;
const snapshotJson = Schema.fromJsonString(Snapshot);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const isManagedWorktreeError = Schema.is(ManagedWorktreeError);
const failure = (cause: unknown) =>
  isManagedWorktreeError(cause)
    ? cause
    : new ManagedWorktreeError({
        detail: cause instanceof Error ? cause.message : "Worktree operation failed.",
        cause,
      });

export class ManagedWorktrees extends Context.Service<
  ManagedWorktrees,
  {
    readonly list: (
      input: ManagedWorktreesListInput,
    ) => Effect.Effect<ReadonlyArray<ManagedWorktreeGroup>, ManagedWorktreeError>;
    readonly remove: (
      input: ManagedWorktreesRemoveInput,
    ) => Effect.Effect<ReadonlyArray<ManagedWorktreeResult>, ManagedWorktreeError>;
    readonly restore: (
      input: ManagedWorktreesRestoreInput,
    ) => Effect.Effect<void, ManagedWorktreeError>;
  }
>()("t3/workspace/ManagedWorktrees") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const fingerprint = Effect.fn("ManagedWorktrees.fingerprint")((value: unknown) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))
      .pipe(Effect.map(Hex.encode), Effect.orDie),
  );
  const git = yield* GitVcsDriver.GitVcsDriver;
  const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const home = yield* HostProcess.HomeDirectory;
  const workingDirectory = yield* HostProcess.WorkingDirectory;
  const contains = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const canonical = Effect.fn("ManagedWorktrees.canonical")((target: string) =>
    fs.realPath(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(path.resolve(target)),
      ),
    ),
  );
  const roots = Effect.fn("ManagedWorktrees.roots")(function* () {
    return (yield* Effect.forEach(
      managedWorktreesDirectories(yield* settings.getSettings, config.worktreesDir, path, home),
      canonical,
    )).filter((root) => !isFilesystemRoot(root, path));
  });
  const save = Effect.fn("ManagedWorktrees.save")(function* (snapshot: Snapshot) {
    const payload = yield* Schema.encodeEffect(snapshotJson)(snapshot);
    yield* sql`INSERT INTO managed_worktree_snapshots (group_id, payload_json) VALUES (${snapshot.id}, ${payload}) ON CONFLICT(group_id) DO UPDATE SET payload_json = excluded.payload_json`;
  });
  const snapshots = Effect.fn("ManagedWorktrees.snapshots")(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM managed_worktree_snapshots`;
    return yield* Effect.forEach(rows, (row) =>
      Schema.decodeEffect(snapshotJson)(row.payload_json),
    );
  });
  const readThreads = Effect.fn("ManagedWorktrees.readThreads")(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL OR json_extract(payload_json, '$.workspace') IS NOT NULL`;
    return yield* Effect.forEach(rows, (row) => decodeThread(row.payload_json));
  });
  const threadPaths = (thread: CleanupThread) =>
    thread.workspace
      ? thread.workspace.resources.map((resource) => resource.checkoutRoot)
      : thread.worktreePath
        ? [thread.worktreePath]
        : [];
  const inventory = Effect.fn("ManagedWorktrees.inventory")(function* () {
    const threads = yield* readThreads();
    const groups: Array<{ id: string; threads: CleanupThread[]; paths: string[] }> = [];
    for (const thread of threads) {
      const paths = yield* Effect.forEach(threadPaths(thread), canonical);
      if (paths.length === 0) continue;
      const overlapping = groups.filter((group) =>
        group.paths.some((root) =>
          paths.some((target) => contains(root, target) || contains(target, root)),
        ),
      );
      const members = [thread, ...overlapping.flatMap((group) => group.threads)].sort(
        (left, right) => left.id.localeCompare(right.id),
      );
      const combined = [
        ...new Set([...paths, ...overlapping.flatMap((group) => group.paths)]),
      ].sort();
      for (const group of overlapping) groups.splice(groups.indexOf(group), 1);
      groups.push({ id: yield* fingerprint(combined), threads: members, paths: combined });
    }
    return groups;
  });
  type Group = Effect.Success<ReturnType<typeof inventory>>[number];
  const assertIdle = Effect.fn("ManagedWorktrees.assertIdle")(function* (group: Group) {
    const serverDirectory = yield* canonical(workingDirectory);
    if (group.paths.some((root) => contains(root, serverDirectory)))
      return yield* new ManagedWorktreeError({
        detail: "This worktree hosts the running T3 server.",
      });
    for (const thread of group.threads) {
      if (thread.deletedAt !== null) continue;
      const projection = yield* projections.getThreadRecords(thread.id, [
        "runs",
        "runtimeRequests",
      ]);
      if (
        projection.runs.some((run) =>
          ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
        ) ||
        projection.runtimeRequests.some((request) => request.status === "pending")
      )
        return yield* new ManagedWorktreeError({
          detail: `${thread.title}: stop the task and cancel queued messages first.`,
        });
      const shell = yield* projections.getThreadShell(thread.id);
      if ((shell?.pendingBackgroundTasks?.length ?? 0) > 0)
        return yield* new ManagedWorktreeError({
          detail: `${thread.title}: background tasks are still running.`,
        });
    }
    const state = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
    const open = yield* Effect.acquireUseRelease(
      terminals.subscribeMetadata((event) =>
        event.type === "snapshot" ? Ref.set(state, event.terminals) : Effect.void,
      ),
      () => Ref.get(state),
      (stop) => Effect.sync(stop),
    );
    for (const terminal of open) {
      const cwd = yield* canonical(terminal.cwd);
      if (
        ["starting", "running"].includes(terminal.status) &&
        group.paths.some((root) => contains(root, cwd))
      )
        return yield* new ManagedWorktreeError({
          detail: "Close this group's terminals before cleanup or recovery.",
        });
    }
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'`;
    for (const row of rows) {
      const session = yield* decodeSession(row.payload_json);
      const cwd = yield* canonical(session.cwd);
      if (group.paths.some((root) => contains(root, cwd)) && (yield* sessions.isLive(session.id)))
        return yield* new ManagedWorktreeError({
          detail: "A provider session is still using this worktree.",
        });
    }
    for (const thread of group.threads) {
      const pending =
        yield* sql`SELECT 1 FROM workspace_restores WHERE thread_id = ${thread.id} AND stage != 'complete' LIMIT 1`;
      if (pending.length > 0)
        return yield* new ManagedWorktreeError({
          detail: "Finish group recovery before cleaning these worktrees.",
        });
    }
  });
  const inspectionContext = Effect.fn("ManagedWorktrees.inspectionContext")(function* () {
    const projectRows = yield* projects.list({ includeDeleted: true });
    const projectPaths = yield* Effect.forEach(
      projectRows.flatMap((entry) =>
        entry.deletedAt === null
          ? [
              entry.workspaceRoot,
              ...(entry.workspaceConfig?.roots.map((root) => root.sourcePath) ?? []),
            ]
          : [],
      ),
      canonical,
    );
    const history = yield* sql<{
      thread_id: string;
      payload_json: string;
    }>`SELECT s.thread_id, s.payload_json FROM orchestration_v2_projection_checkpoint_scopes s JOIN orchestration_v2_projection_threads t ON t.thread_id = s.thread_id WHERE t.deleted_at IS NULL`;
    const historyPaths = Schema.fromJsonString(
      Schema.Struct({
        cwd: Schema.optional(Schema.String),
        workspace: Schema.optional(ThreadWorkspaceRevision),
      }),
    );
    const scopes = yield* Effect.forEach(history, (row) =>
      Effect.gen(function* () {
        const scope = yield* Schema.decodeEffect(historyPaths)(row.payload_json);
        const paths =
          scope.workspace?.resources.map((resource) => resource.checkoutRoot) ??
          (scope.cwd ? [scope.cwd] : []);
        return { threadId: row.thread_id, paths: yield* Effect.forEach(paths, canonical) };
      }),
    );
    return {
      projectRows,
      projectPaths,
      scopes,
      saved: yield* snapshots(),
      managedRoots: yield* roots(),
    };
  });
  const inspect = Effect.fn("ManagedWorktrees.inspect")(function* (
    group: Group,
    context: Effect.Success<ReturnType<typeof inspectionContext>>,
  ) {
    const { projectRows, projectPaths, scopes, managedRoots } = context;
    const owner = group.threads.find((thread) => thread.deletedAt === null) ?? group.threads[0]!;
    const project = projectRows.find((item) => item.projectId === owner.projectId);
    const saved = context.saved.find((item) => item.id === group.id);
    let reason: string | null = group.paths.some((root) =>
      group.paths.some((target) => root !== target && contains(root, target)),
    )
      ? "Nested worktrees must be cleaned manually."
      : null;
    const resources: ManagedWorktreeGroup["resources"][number][] = [];
    const identities: Array<typeof SavedResource.Type> = [];
    const idle = yield* assertIdle(group).pipe(Effect.result);
    if (idle._tag === "Failure") reason = failure(idle.failure).message;
    for (const checkout of group.paths) {
      const present = yield* fs.exists(checkout);
      const previous = saved?.resources.find(
        (resource) => resource.identity.checkoutRoot === checkout,
      );
      let branch = previous?.branch ?? null;
      let ignoredFiles = false;
      if (!managedRoots.some((root) => root !== checkout && contains(root, checkout)))
        reason ??= "This checkout is outside the managed worktree directories.";
      if (
        group.threads.some((thread) =>
          thread.workspace?.resources.some(
            (resource) => resource.checkoutRoot === checkout && resource.ownership !== "managed",
          ),
        )
      )
        reason ??= "Borrowed repositories cannot be removed.";
      if (projectPaths.some((source) => contains(checkout, source)))
        reason ??= "This directory is used by a project checkout.";
      if (present) {
        const identity = yield* resolver.inspect(checkout);
        if (identity.checkoutRoot !== checkout || identity.gitDir === identity.commonDir)
          reason ??= "The main repository cannot be removed.";
        if (yield* fs.exists(path.join(identity.gitDir, "locked")))
          reason ??= "This worktree is locked.";
        for (const thread of group.threads) {
          const resource = thread.workspace?.resources.find(
            (item) => item.checkoutRoot === checkout,
          );
          if (resource) yield* resolver.verify(previous?.restoredIdentity ?? resource.identity);
        }
        const status = yield* git.execute({
          operation: "ManagedWorktrees.inspect",
          cwd: checkout,
          args: [
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--ignored",
            "--ignore-submodules=none",
          ],
        });
        if (status.stdoutTruncated)
          reason ??= "The status output was truncated; this worktree was retained.";
        const entries = status.stdout.split("\0").filter(Boolean);
        ignoredFiles = entries.some((entry) => entry.startsWith("!! "));
        if (entries.some((entry) => !entry.startsWith("!! ")))
          reason ??= "This worktree has local changes or untracked files.";
        const ref = yield* git.execute({
          operation: "ManagedWorktrees.branch",
          cwd: checkout,
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
        });
        branch = ref.stdout.trim() === "HEAD" ? null : ref.stdout.trim();
        const commit = yield* git.resolveCommit({ cwd: checkout, revision: "HEAD" });
        identities.push({
          identity,
          branch,
          commit: commit.commitSha,
          ref: `refs/t3/worktree-cleanup/${group.id}/${identities.length}`,
          removed: false,
        });
        const submodules = yield* git.execute({
          operation: "ManagedWorktrees.submodules",
          cwd: checkout,
          args: ["ls-files", "--stage"],
        });
        if (
          submodules.stdoutTruncated ||
          submodules.stdout.split("\n").some((line) => line.startsWith("160000 "))
        )
          reason ??= "Worktrees containing submodules must be cleaned manually.";
      } else if (previous) {
        identities.push(previous);
      } else {
        reason ??= "This worktree is missing and has no manual cleanup snapshot.";
      }
      resources.push({
        path: checkout,
        name: path.basename(checkout),
        branch,
        present,
        ignoredFiles,
      });
    }
    for (const scope of scopes) {
      if (group.threads.some((thread) => thread.id === scope.threadId)) continue;
      if (scope.paths.some((target) => group.paths.some((root) => contains(root, target))))
        reason ??= "Another task's history still uses this worktree.";
    }
    const missing = resources.filter((resource) => !resource.present).length;
    const token = yield* fingerprint({
      identities,
      threads: group.threads.map((thread) => [
        thread.id,
        thread.workspace?.id,
        thread.worktreePath,
        thread.deletedAt,
      ]),
      reason,
    });
    const report: ManagedWorktreeGroup = {
      id: group.id,
      fingerprint: token,
      projectId: owner.projectId,
      projectTitle: project?.title ?? owner.projectId,
      title: owner.title,
      threads: group.threads
        .filter((thread) => thread.deletedAt === null)
        .map((thread) => ({ id: thread.id, title: thread.title })),
      resources,
      recoveryPending: saved !== undefined,
      status:
        saved && missing === resources.length
          ? "removed"
          : reason
            ? "blocked"
            : saved || missing > 0
              ? "partial"
              : "ready",
      reason,
    };
    return { report, identities, saved };
  });
  const list = Effect.fn("ManagedWorktrees.list")(function* (input: ManagedWorktreesListInput) {
    const groups = yield* inventory();
    const context = yield* inspectionContext();
    return yield* Effect.forEach(
      groups.filter(
        (group) =>
          input.projectIds === undefined ||
          group.threads.some((thread) => input.projectIds!.includes(thread.projectId)),
      ),
      (group) =>
        inspect(group, context).pipe(
          Effect.map((result) => result.report),
          Effect.catch((cause) =>
            Effect.succeed({
              id: group.id,
              fingerprint: "unavailable",
              projectId: group.threads[0]!.projectId,
              projectTitle: group.threads[0]!.projectId,
              title: group.threads[0]!.title,
              threads: group.threads.map((thread) => ({ id: thread.id, title: thread.title })),
              resources: group.paths.map((checkout) => ({
                path: checkout,
                name: path.basename(checkout),
                branch: null,
                present: true,
                ignoredFiles: false,
              })),
              status: "failed" as const,
              recoveryPending: context.saved.some((snapshot) => snapshot.id === group.id),
              reason: failure(cause).message,
            }),
          ),
        ),
      { concurrency: 4 },
    );
  }, Effect.mapError(failure));
  const remove = Effect.fn("ManagedWorktrees.remove")(function* (
    input: ManagedWorktreesRemoveInput,
  ) {
    const results: ManagedWorktreeResult[] = [];
    for (const target of input.targets) {
      const group = (yield* inventory()).find((entry) => entry.id === target.id);
      if (!group) {
        results.push({
          id: target.id,
          outcome: "skipped",
          detail: "The worktree group changed. Refresh the list.",
        });
        continue;
      }
      const result = yield* assertIdle(group).pipe(
        Effect.andThen(
          withWorkspaceLeases(
            group.threads.flatMap(
              (thread) =>
                thread.workspace?.resources.map((resource) => `resource:${resource.id}`) ?? [],
            ),
            withWorkspaceLeases(
              group.paths,
              Effect.gen(function* () {
                const current = (yield* inventory()).find((entry) => entry.id === target.id);
                if (!current)
                  return yield* new ManagedWorktreeError({
                    detail: "The worktree group changed. Refresh the list.",
                  });
                const checked = yield* inspect(current, yield* inspectionContext());
                if (checked.report.fingerprint !== target.fingerprint)
                  return yield* new ManagedWorktreeError({
                    detail: "The worktree changed since inspection. Refresh and confirm again.",
                  });
                if (!["ready", "partial"].includes(checked.report.status))
                  return yield* new ManagedWorktreeError({
                    detail: checked.report.reason ?? "This group cannot be cleaned.",
                  });
                if (
                  !input.deleteIgnoredFiles &&
                  checked.report.resources.some((resource) => resource.ignoredFiles)
                )
                  return yield* new ManagedWorktreeError({
                    detail: "Confirm deletion of ignored files first.",
                  });
                if (
                  checked.saved?.resources.some(
                    (resource) => resource.restoredIdentity !== undefined,
                  )
                )
                  return yield* new ManagedWorktreeError({
                    detail: "Finish rebuilding this group before cleaning it again.",
                  });
                let snapshot: Snapshot = {
                  id: current.id,
                  threads: current.threads.map((thread) => ({
                    id: thread.id,
                    ...(thread.workspace ? { workspace: thread.workspace } : {}),
                  })),
                  resources: checked.identities,
                };
                for (const resource of snapshot.resources) {
                  if (yield* fs.exists(resource.identity.checkoutRoot))
                    yield* git.execute({
                      operation: "ManagedWorktrees.retainCommit",
                      cwd: resource.identity.checkoutRoot,
                      args: ["update-ref", resource.ref, resource.commit],
                    });
                }
                yield* save(snapshot);
                for (const resource of snapshot.resources) {
                  if (!(yield* fs.exists(resource.identity.checkoutRoot))) continue;
                  yield* assertIdle(current);
                  yield* resolver.verify(resource.identity);
                  const status = yield* git.execute({
                    operation: "ManagedWorktrees.recheck",
                    cwd: resource.identity.checkoutRoot,
                    args: [
                      "status",
                      "--porcelain",
                      "-z",
                      "--untracked-files=all",
                      "--ignored",
                      "--ignore-submodules=none",
                    ],
                  });
                  if (
                    status.stdoutTruncated ||
                    status.stdout
                      .split("\0")
                      .filter(Boolean)
                      .some((entry) => !input.deleteIgnoredFiles || !entry.startsWith("!! "))
                  )
                    return yield* new ManagedWorktreeError({
                      detail:
                        "Local changes appeared during cleanup. Remaining worktrees were retained.",
                    });
                  const head = yield* git.resolveCommit({
                    cwd: resource.identity.checkoutRoot,
                    revision: "HEAD",
                  });
                  const branch = yield* git.execute({
                    operation: "ManagedWorktrees.recheckBranch",
                    cwd: resource.identity.checkoutRoot,
                    args: ["rev-parse", "--abbrev-ref", "HEAD"],
                  });
                  if (
                    head.commitSha !== resource.commit ||
                    branch.stdout.trim() !== (resource.branch ?? "HEAD")
                  )
                    return yield* new ManagedWorktreeError({
                      detail: "The branch or commit changed during cleanup.",
                    });
                  yield* removeLinkedWorktree({
                    operation: "ManagedWorktrees.remove",
                    cwd: resource.identity.commonDir,
                    worktreePath: resource.identity.checkoutRoot,
                    force: false,
                    execute: git.execute,
                    run: (args) =>
                      git.execute({
                        operation: "ManagedWorktrees.remove",
                        cwd: resource.identity.commonDir,
                        args: ["--git-dir", resource.identity.commonDir, ...args],
                      }),
                  }).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, path),
                  );
                  snapshot = Object.assign({}, snapshot, {
                    resources: snapshot.resources.map((entry) =>
                      entry.identity.checkoutRoot === resource.identity.checkoutRoot
                        ? { ...entry, removed: true }
                        : entry,
                    ),
                  });
                  yield* save(snapshot);
                }
              }),
            ),
          ),
        ),
        Effect.result,
      );
      results.push(
        result._tag === "Success"
          ? {
              id: target.id,
              outcome: "removed",
              detail: "Worktrees removed. Branches and thread history retained.",
            }
          : { id: target.id, outcome: "failed", detail: failure(result.failure).message },
      );
    }
    return results;
  }, Effect.mapError(failure));
  const restore = Effect.fn("ManagedWorktrees.restore")(function* (
    input: ManagedWorktreesRestoreInput,
  ) {
    const saved = (yield* snapshots()).find((item) =>
      item.threads.some((thread) => thread.id === input.threadId),
    );
    if (!saved) return;
    const group = (yield* inventory()).find((entry) => entry.id === saved.id);
    if (!group)
      return yield* new ManagedWorktreeError({
        detail: "The saved worktree group no longer matches its threads.",
      });
    yield* assertIdle(group);
    yield* withWorkspaceLeases(
      group.threads.flatMap(
        (thread) => thread.workspace?.resources.map((resource) => `resource:${resource.id}`) ?? [],
      ),
      withWorkspaceLeases(
        group.paths,
        Effect.gen(function* () {
          yield* assertIdle(group);
          let snapshot = (yield* snapshots()).find((item) => item.id === saved.id);
          if (!snapshot) return;
          for (const resource of snapshot.resources) {
            if (yield* fs.exists(resource.identity.checkoutRoot)) {
              yield* resolver.verify(resource.restoredIdentity ?? resource.identity);
              continue;
            }
            const common = yield* fs.realPath(resource.identity.commonDir);
            yield* resolver.verifyRepository(resource.identity);
            const branch = resource.branch;
            const revision = branch === null ? resource.ref : `refs/heads/${branch}`;
            yield* git.execute({
              operation: "ManagedWorktrees.restore",
              cwd: common,
              args: [
                "--git-dir",
                common,
                "worktree",
                "add",
                ...(branch === null ? ["--detach"] : []),
                "--",
                resource.identity.checkoutRoot,
                branch ?? revision,
              ],
            });
            const restoredIdentity = yield* resolver.inspect(resource.identity.checkoutRoot);
            if (restoredIdentity.commonDirIdentity !== resource.identity.commonDirIdentity)
              return yield* new ManagedWorktreeError({
                detail: "The source repository was replaced. Recovery stopped.",
              });
            snapshot = Object.assign({}, snapshot, {
              resources: snapshot.resources.map((entry) =>
                entry.identity.checkoutRoot === resource.identity.checkoutRoot
                  ? { ...entry, restoredIdentity }
                  : entry,
              ),
            });
            yield* save(snapshot);
          }
          for (const member of snapshot.threads) {
            if (!member.workspace) continue;
            const { thread, providerSessions } = yield* projections.getThreadRecords(member.id, [
              "providerSessions",
            ]);
            if (thread.deletedAt !== null) continue;
            if (thread.workspace?.id === member.restoredWorkspace?.id) continue;
            if (thread.workspace?.id !== member.workspace.id)
              return yield* new ManagedWorktreeError({
                detail: "The thread's workspace changed after cleanup.",
              });
            const revision = member.restoredWorkspace ?? {
              ...member.workspace,
              id: WorkspaceRevisionId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
              previousRevisionId: member.workspace.id,
              createdAt: DateTime.formatIso(yield* DateTime.now),
              resources: member.workspace.resources.map((resource) => {
                const restored = snapshot!.resources.find(
                  (entry) => entry.identity.checkoutRoot === resource.checkoutRoot,
                )?.restoredIdentity;
                return restored
                  ? { ...resource, identity: restored, generation: resource.generation + 1 }
                  : resource;
              }),
            };
            snapshot = Object.assign({}, snapshot, {
              threads: snapshot.threads.map((entry) =>
                entry.id === member.id ? { ...entry, restoredWorkspace: revision } : entry,
              ),
            });
            yield* save(snapshot);
            for (const session of providerSessions.filter((entry) => entry.status !== "stopped")) {
              yield* sessions.detach({
                providerSessionId: session.id,
                threadId: member.id,
                revokeMcpCredential: true,
              });
              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make(`worktree-restore:${revision.id}:${session.id}`),
                threadId: member.id,
                providerSessionId: session.id,
                reason: "Worktree recovery",
              });
            }
            yield* orchestrator.dispatch({
              type: "thread.workspace.bind",
              commandId: CommandId.make(`worktree-restore:${revision.id}`),
              threadId: member.id,
              expectedWorkspaceRevisionId: member.workspace.id,
              workspace: revision,
              restoringFromCleanup: true,
            });
          }
          yield* sql`DELETE FROM managed_worktree_snapshots WHERE group_id = ${snapshot.id}`;
        }),
      ),
    );
  }, Effect.mapError(failure));
  return ManagedWorktrees.of({ list, remove, restore });
});

export const layer = Layer.effect(ManagedWorktrees, make);
