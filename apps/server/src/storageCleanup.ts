import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as WorkspaceCleanup from "./workspace/WorkspaceCleanup.ts";
import * as WorkspaceRepositoryResolver from "./workspace/WorkspaceRepositoryResolver.ts";
import {
  GitCommandError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
  StorageCleanupReport,
  StorageCleanupReportEntry,
} from "@t3tools/contracts";
import { resolveProjectSettings, resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { isMainOrMasterBranch } from "@t3tools/shared/git";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { parse as parseYaml } from "yaml";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { sourceControlDefinitions } from "./sourceControl/sourceControlDefinitions.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { removeLinkedWorktree } from "./vcs/worktreeRemoval.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { isNetworkPath } from "@t3tools/shared/path";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
// pnpm 11 writes this file as JSON, older versions as YAML.
const decodePnpmModulesManifest = Schema.decodeUnknownEffect(
  Schema.Struct({
    storeDir: Schema.String,
    virtualStoreDir: Schema.optional(Schema.String),
  }),
);

const DAY_MS = 86_400_000;
// Give settle scripts time to open terminals that protect the worktree.
const SETTLE_SCRIPT_GRACE_MS = 60_000;
// Worktree creation can precede its thread row, including review-guide checkouts.
const ORPHAN_WORKTREE_GRACE_MS = 60 * 60 * 1_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const REPORT_ENTRY_LIMIT = 200;
const isGitCommandError = Schema.is(GitCommandError);

function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeSettledAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every(
    (projectId) =>
      Equal.equals(
        left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
        right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      ) &&
      left.projectSettingsOverrides[projectId as ProjectId]?.autoDeleteMergedBranches ===
        right.projectSettingsOverrides[projectId as ProjectId]?.autoDeleteMergedBranches,
  );
}

export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return thread.worktreePath !== null && threadIdle(thread, now);
}

function threadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.activeRunId === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

/** Only a complete subagent chain within this worktree shares ownership. */
function worktreeOwner<T extends Pick<OrchestrationV2ThreadShell, "id" | "lineage">>(
  threads: ReadonlyArray<T>,
) {
  if (threads.length === 1) return threads[0];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tops = threads.filter((thread) => !byId.has(thread.lineage.parentThreadId!));
  if (tops.length !== 1) return undefined;
  const owner = tops[0]!;
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.id !== owner.id) {
      if (
        seen.has(current.id) ||
        current.lineage.relationshipToParent !== "subagent" ||
        current.lineage.rootThreadId !== owner.lineage.rootThreadId
      )
        return undefined;
      seen.add(current.id);
      const parent = byId.get(current.lineage.parentThreadId!);
      if (parent === undefined) return undefined;
      current = parent;
    }
  }
  return owner;
}

/** Squash/rebase merges require the merged PR to name this exact head commit. */
export function storageCleanupPullRequestMerged(
  pullRequest: Pick<
    GitManager.GitBranchPullRequest,
    "state" | "headRef" | "baseRef" | "headSha"
  > | null,
  worktree: {
    readonly branch: string;
    readonly defaultBranch: string;
    readonly headSha: string;
    readonly integrated: boolean;
  },
): boolean {
  return (
    pullRequest?.state === "merged" &&
    (worktree.integrated ||
      (pullRequest.headRef === worktree.branch &&
        pullRequest.baseRef === worktree.defaultBranch &&
        pullRequest.headSha === worktree.headSha))
  );
}

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly runNow: Effect.Effect<StorageCleanupReport, ServerSettingsError>;
    readonly latestReport: Effect.Effect<StorageCleanupReport | null>;
    readonly reports: Stream.Stream<StorageCleanupReport | null>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/storageCleanup") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const workspaceCleanup = yield* WorkspaceCleanup.WorkspaceCleanup;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const orphanSizes = new Map<string, number | null>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const isWindows = yield* HostProcess.isWindows;
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  // pnpm imports packages by clone or reflink when its store shares a device
  // with the worktree. Those files have one link but share blocks with the
  // store, so removing them frees almost nothing. A store on another device
  // forces real copies, which still count.
  const sharedPnpmVirtualStore = Effect.fnUntraced(
    function* (root: string) {
      const nodeModules = path.join(root, "node_modules");
      const text = yield* fs.readFileString(path.join(nodeModules, ".modules.yaml"));
      const manifest = yield* decodePnpmModulesManifest(yield* Effect.try(() => parseYaml(text)));
      // An agent can write this manifest, and statting a network path makes
      // Windows sign in to its host with the user's NTLM credentials.
      if (isNetworkPath(manifest.storeDir) || isNetworkPath(manifest.virtualStoreDir ?? "")) {
        return null;
      }
      const virtualStore = path.resolve(nodeModules, manifest.virtualStoreDir ?? ".pnpm");
      const [store, virtual] = yield* Effect.all([
        fs.stat(manifest.storeDir),
        fs.stat(virtualStore),
      ]);
      return store.dev === virtual.dev ? virtualStore : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const measureWorktree = Effect.fn("storageCleanup.measureWorktree")(
    function* (worktreePath: string) {
      const root = yield* fs.realPath(worktreePath);
      const skipped = yield* sharedPnpmVirtualStore(root);
      const pending = [root];
      let entries = 1;
      let bytes = 0;
      while (pending.length > 0) {
        const target = pending.pop()!;
        if (target === skipped) continue;
        // Effect's stat follows links. Probe with readLink first to get lstat
        // semantics, including skipping dangling links and directory links.
        const isLink = yield* fs.readLink(target).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) =>
              error.cause instanceof Error &&
              "code" in error.cause &&
              error.cause.code === "EINVAL",
            () => Effect.succeed(false),
          ),
        );
        if (isLink) continue;
        if ((yield* fs.realPath(target)) !== target) return null;
        const stat = yield* fs.stat(target);
        if (stat.type === "File") {
          // Removing a shared hardlink leaves its blocks allocated.
          if (Option.getOrElse(stat.nlink, () => 1n) !== 1n) continue;
          bytes += Option.match(stat.blocks, {
            onNone: () => Number(stat.size),
            onSome: (blocks) => Number(blocks * 512n),
          });
        } else if (stat.type === "Directory") {
          const names = yield* fs.readDirectory(target);
          entries += names.length;
          if (entries > 2_000_000) return null;
          for (const name of names) {
            const child = path.join(target, name);
            if (!inside(root, child)) return null;
            pending.push(child);
          }
        }
      }
      return bytes;
    },
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => null),
  );

  // Large snapshots take seconds; use the reader worker instead of blocking the event loop.
  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const snapshot = yield* projections.getShellSnapshot().pipe(NodeSqliteClient.readOnly);
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...snapshot.threads, ...snapshot.archivedThreads] };
  });

  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (pathKey(projectPath) === pathKey(worktreePath) || inside(worktreePath, projectPath))
        return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (pathKey(realPath) === pathKey(worktreePath) || inside(worktreePath, realPath))
        return true;
    }
    return false;
  });

  const reportOrphanWorktrees = Effect.fn("StorageCleanup.reportOrphanWorktrees")(function* (
    roots: ReadonlyArray<string>,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
    entries: StorageCleanupReportEntry[],
  ) {
    const rows = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
      UNION SELECT json_extract(resource.value, '$.checkoutRoot') AS worktreePath
      FROM orchestration_v2_projection_workspace_revisions, json_each(payload_json, '$.resources') AS resource
      UNION SELECT json_extract(resource.value, '$.path') AS worktreePath
      FROM workspace_preparations, json_each(payload_json, '$.resources') AS resource
    `.pipe(NodeSqliteClient.readOnly);
    const referenced = new Set<string>();
    for (const row of rows) {
      const resolved = path.resolve(row.worktreePath);
      referenced.add(pathKey(resolved));
      referenced.add(
        pathKey(yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved))),
      );
    }
    const referencedAncestors = new Set<string>();
    for (let ancestor of referenced) {
      while (roots.some((root) => inside(root, ancestor))) {
        ancestor = pathKey(path.dirname(ancestor));
        referencedAncestors.add(ancestor);
      }
    }
    const projectRoots = (yield* Effect.forEach(
      yield* Effect.filter(projects, (project) =>
        fs.exists(path.resolve(project.workspaceRoot)).pipe(Effect.orElseSucceed(() => true)),
      ),
      (project) => {
        const resolved = path.resolve(project.workspaceRoot);
        return fs.realPath(resolved).pipe(
          Effect.orElseSucceed(() => resolved),
          Effect.map((realPath) => [resolved, realPath]),
        );
      },
    )).flat();
    const inProject = (target: string, managedRoot: string) =>
      projectRoots.some(
        (root) =>
          !inside(root, managedRoot) && (pathKey(root) === pathKey(target) || inside(root, target)),
      );
    const directories = Effect.fnUntraced(function* (parent: string, managedRoot: string) {
      if (inProject(parent, managedRoot)) return [];
      const result: string[] = [];
      for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
        const target = path.join(parent, name);
        if (!inside(parent, target) || inProject(target, managedRoot)) continue;
        const directory = yield* Effect.gen(function* () {
          if (pathKey(yield* fs.realPath(target)) !== pathKey(target)) return false;
          return (yield* fs.stat(target)).type === "Directory";
        }).pipe(Effect.orElseSucceed(() => false));
        if (directory) result.push(target);
      }
      return result;
    });
    // Let the first walk time out and cache unmeasurable folders; later walks share the remaining budget.
    const now = yield* Clock.currentTimeMillis;
    const measurementDeadline = now + 30_000;
    let firstMeasurement = true;
    const reported = new Set<string>();
    const report = Effect.fnUntraced(
      function* (worktreePath: string) {
        const key = pathKey(worktreePath);
        if (
          reported.has(key) ||
          referenced.has(key) ||
          referencedAncestors.has(key) ||
          projectRoots.some((root) => pathKey(root) === key || inside(worktreePath, root))
        )
          return;
        const modified = Option.getOrNull((yield* fs.stat(worktreePath)).mtime);
        if (modified !== null && modified.getTime() > now - ORPHAN_WORKTREE_GRACE_MS) return;
        const gitPath = path.join(worktreePath, ".git");
        const linked = (yield* fs.exists(gitPath)) && (yield* fs.stat(gitPath)).type === "File";
        reported.add(key);
        const remaining = measurementDeadline - (yield* Clock.currentTimeMillis);
        if (!orphanSizes.has(key) && (firstMeasurement || remaining > 0)) {
          const measured = yield* measureWorktree(worktreePath).pipe(
            firstMeasurement ? Effect.asSome : Effect.timeoutOption(remaining),
          );
          firstMeasurement = false;
          if (Option.isSome(measured)) orphanSizes.set(key, measured.value);
        }
        const bytes = orphanSizes.get(key) ?? null;
        entries.push({
          kind: "worktree",
          outcome: "kept",
          reason: linked
            ? "No thread uses this worktree"
            : "No thread uses this folder, and it isn't a git worktree",
          path: worktreePath,
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes,
          files: null,
        });
      },
      Effect.orElseSucceed(() => undefined),
    );
    for (const root of roots) {
      // Worktrees can be <root>/<repository>/<branch> or explicitly <root>/<name>.
      for (const projectDirectory of yield* directories(root, root)) {
        yield* Effect.gen(function* () {
          if (referenced.has(pathKey(projectDirectory))) return;
          const gitPath = path.join(projectDirectory, ".git");
          if (yield* fs.exists(gitPath)) {
            if ((yield* fs.stat(gitPath)).type === "File") yield* report(projectDirectory);
            return;
          }
          for (const worktreePath of yield* directories(projectDirectory, root)) {
            yield* report(worktreePath);
          }
        }).pipe(Effect.orElseSucceed(() => undefined));
      }
    }
    for (const key of orphanSizes.keys()) {
      if (!reported.has(key)) orphanSizes.delete(key);
    }
  });

  // Use two small Git reads: statusDetailsLocal also diffs and counts for every worktree.
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    // Return null for missing/non-repository cwd; force untranslated git diagnostics for matching.
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (result.stderr.toLowerCase().includes("not a git repository")) return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    const ref = head.exitCode === 0 ? head.stdout.trim() : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: WorktreeCleanupRules,
  ) {
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
      maxOutputBytes: 64 * 1024,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    if (rules.worktreeKeepWhen !== "any-local-files") return null;
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
    return file === undefined ? null : `has ignored files (${file})`;
  });

  const submoduleRemoval = Effect.fn("StorageCleanup.submoduleRemoval")(
    function* (cwd: string, rules: WorktreeCleanupRules) {
      const inspect = (args: string[], maxOutputBytes = 64 * 1024) =>
        git.execute({
          operation: "StorageCleanup.submodules",
          cwd,
          args,
          maxOutputBytes,
        });
      const admin = yield* inspect(["rev-parse", "--absolute-git-dir"]);
      if (admin.stdoutTruncated || admin.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const modules = path.join(admin.stdout.replace(/\n$/, ""), "modules");
      const stored = yield* fs.exists(modules);
      if (!stored && !(yield* fs.exists(path.join(cwd, ".gitmodules"))))
        return { force: false, reason: null };
      const populated = yield* inspect([
        "submodule",
        "foreach",
        "--recursive",
        "--quiet",
        'printf "%s\\0" "$toplevel/$sm_path"',
      ]);
      if (populated.stdoutTruncated || populated.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const paths = populated.stdout.split("\0").filter(Boolean);
      const pending = [modules];
      for (const submodule of paths) {
        const directory = yield* inspect(["-C", submodule, "rev-parse", "--absolute-git-dir"]);
        if (directory.stdoutTruncated || directory.stderrTruncated)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        pending.push(directory.stdout.replace(/\n$/, ""));
      }
      const visited = new Set<string>();
      while (pending.length > 0) {
        const directory = pending.pop()!;
        if (!(yield* fs.exists(directory))) continue;
        const canonical = yield* fs.realPath(directory);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        if (visited.size > 10_000)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        if ((yield* fs.stat(directory)).type !== "Directory")
          return { force: false, reason: "submodule repository could not be inspected" };
        if (yield* fs.exists(path.join(directory, "HEAD"))) {
          const unpushed = yield* inspect([
            "--git-dir",
            directory,
            "--work-tree",
            cwd,
            "rev-list",
            "--max-count=1",
            "HEAD",
            "--all",
            "--reflog",
            "--not",
            "--remotes",
          ]);
          if (unpushed.stdoutTruncated || unpushed.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          if (unpushed.stdout.trim() !== "")
            return { force: false, reason: "submodule has commits not on a remote-tracking ref" };
          pending.push(path.join(directory, "modules"));
        } else {
          for (const name of yield* fs.readDirectory(directory))
            pending.push(path.join(directory, name));
        }
      }
      // Check files after walking stored history to shorten the gap before forced removal.
      for (const submodule of paths) {
        const changes = yield* localChangesReason(submodule, rules);
        if (changes !== null) return { force: false, reason: `submodule ${changes}` };
      }
      const force = stored || paths.length > 0;
      if (force && rules.worktreeKeepWhen !== "tracked-changes") {
        const root = yield* fs.realPath(cwd);
        // Git status and foreach omit files inside deinitialized gitlink directories.
        const populatedPaths = new Set(paths.map(pathKey));
        const unchecked: string[] = [];
        for (const repository of [root, ...paths]) {
          const index = yield* inspect(
            ["-C", repository, "ls-files", "--stage", "-z"],
            16 * 1024 * 1024,
          );
          if (index.stdoutTruncated || index.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          for (const entry of index.stdout.split("\0")) {
            if (!entry.startsWith("160000 ")) continue;
            const submodule = path.resolve(repository, entry.slice(entry.indexOf("\t") + 1));
            if (!inside(root, submodule))
              return { force: false, reason: "submodules could not be inspected" };
            if (!populatedPaths.has(pathKey(submodule)) && (yield* fs.exists(submodule)))
              unchecked.push(submodule);
          }
        }
        let inspected = unchecked.length;
        while (unchecked.length > 0) {
          if (inspected > 10_000)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          const target = unchecked.pop()!;
          if (
            (yield* fs.realPath(target)) !== path.resolve(target) ||
            (yield* fs.stat(target)).type !== "Directory"
          )
            return { force: false, reason: "submodule has local files" };
          if (path.basename(target) === "node_modules") continue;
          const names = yield* fs.readDirectory(target);
          inspected += names.length;
          for (const name of names) unchecked.push(path.join(target, name));
        }
      }
      return { force, reason: null };
    },
    Effect.orElseSucceed(() => ({ force: false, reason: "submodules could not be inspected" })),
  );

  const cleanupGit = Effect.fn("StorageCleanup.cleanupGit")(function* (
    cwd: string,
    args: string[],
    command: string,
  ) {
    const result = yield* git.execute({
      operation: "StorageCleanup.cleanupGit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0)
      return yield* new GitCommandError({
        operation: "StorageCleanup.cleanupGit",
        command,
        cwd,
        detail: result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      });
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      serverSettings,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    )) {
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    const deletedRows = yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `.pipe(NodeSqliteClient.readOnly);
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter((thread) => thread.worktreePath !== null && thread.branch !== null);
    const snapshot = yield* readThreads();
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const defaultBranches = new Map<string, string | null>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const deletedByPath = Map.groupBy(deletedThreads, (thread) =>
      path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups].map(
        ([worktreePath, group]) =>
          // A deleted thread still owns the worktree its remaining subagents share,
          // but only deletion cleanup acts on it; otherwise the live rules apply.
          deletedByPath
            .get(worktreePath)
            ?.find(
              (deleted) =>
                resolveWorktreeCleanup(serverSettings, deleted.projectId).worktreeOnDelete &&
                worktreeOwner([deleted, ...group]) === deleted,
            ) ??
          worktreeOwner(group) ??
          group[0]!,
      ),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath!))),
    ];
    for (const thread of candidates) {
      if (thread.workspace !== undefined) {
        const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
        const entry: StorageCleanupReportEntry = {
          kind: "worktree",
          outcome: "kept",
          reason: "Workspace history retains this group until its task is deleted",
          path: thread.worktreePath!,
          projectPath: null,
          threadId: thread.id,
          threadTitle: thread.title,
          bytes: null,
          files: null,
        };
        if (!("workspaceRoot" in thread) || !settings.worktreeOnDelete) {
          entries.push(entry);
          continue;
        }
        const result = yield* workspaceCleanup
          .remove({
            threadId: thread.id,
            workspace: thread.workspace,
            managedRoots: roots,
            isOccupied: Effect.fn("StorageCleanup.workspaceOccupied")(
              function* (cwd) {
                if (hasTerminal(cwd)) return true;
                const sessionRows = yield* sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'`;
                for (const row of sessionRows) {
                  const session = yield* decodeCleanupSession(row.payload_json);
                  if (
                    (session.cwd === cwd || inside(cwd, session.cwd)) &&
                    (yield* providerSessions.isLive(session.id))
                  )
                    return true;
                }
                return false;
              },
              (effect) =>
                effect.pipe(
                  Effect.mapError(
                    (cause) =>
                      new WorkspaceCleanup.WorkspaceCleanupError({
                        revisionId: thread.workspace!.id,
                        detail: "Cannot inspect workspace occupancy.",
                        cause,
                      }),
                  ),
                ),
            ),
          })
          .pipe(Effect.result);
        entries.push(
          result._tag === "Success"
            ? {
                ...entry,
                outcome: "removed",
                reason: "Deleted task worktree group removed; branches and history retained",
              }
            : { ...entry, reason: result.failure.message },
        );
        continue;
      }
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      const group = groups.get(worktreePath) ?? [];
      const activityAt = Math.max(...group.map(storageCleanupActivityAt));
      const deleted = "workspaceRoot" in thread;
      const members = deleted ? [thread, ...group] : group;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: worktreePath,
        projectPath: project?.workspaceRoot ?? null,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      const keep = (reason: string) => entries.push({ ...entry, reason: sentence(reason) });
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(worktreePath))) return;
        if (deleted && !settings.worktreeOnDelete) return keep("no rules apply");
        if (members.length > 1 && worktreeOwner(members) === undefined)
          return keep(`shared by ${members.length} threads`);
        if (project === undefined) return keep("project is unavailable");
        if (
          thread.branch === null ||
          !group.every((member) => storageCleanupThreadIdle(member, now))
        )
          return keep("thread is running or has pending work");
        if (group.some((member) => member.branch !== thread.branch))
          return keep("a subagent thread's branch differs from this worktree's branch");
        if (hasTerminal(worktreePath)) return keep("open terminal");
        // Compare canonical roots while allowing symlinked parents, never symlinked worktree directories.
        const realPath = yield* fs.realPath(worktreePath);
        const realParent = yield* fs.realPath(path.dirname(worktreePath));
        if (realPath !== path.join(realParent, path.basename(worktreePath)))
          return keep("worktree is a symbolic link");
        if (!roots.some((root) => inside(root, realPath)))
          return keep("outside the managed worktree folder");
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects]))
          return keep("contains a project checkout");
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
          return keep("not a linked worktree");
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed");
        const changes = yield* localChangesReason(worktreePath, settings);
        if (changes !== null) return keep(changes);
        if (
          group.some(
            (member) =>
              member.settledAt !== null &&
              now - Math.max(DateTime.toEpochMillis(member.updatedAt), activityAt) <
                SETTLE_SCRIPT_GRACE_MS,
          )
        )
          return keep("settled moments ago");
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          activityAt < now - settings.worktreeAfterDays * DAY_MS;
        const settledFor =
          deleted || thread.settledAt === null
            ? null
            : now - Math.max(DateTime.toEpochMillis(thread.settledAt), activityAt);
        const settledDays = settledFor === null ? null : Math.floor(settledFor / DAY_MS);
        const settled =
          settledFor !== null &&
          settings.worktreeSettledAfterDays !== null &&
          settledFor >= settings.worktreeSettledAfterDays * DAY_MS;
        let eligible = deleted || old || settled;
        let removalReason = deleted
          ? "thread was deleted"
          : old
            ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} days`
            : `settled for ${settledDays} days`;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const defaultBranchKey = `${repositoryCwd}\0${remote}`;
          let branch = defaultBranches.get(defaultBranchKey);
          if (branch === undefined) {
            branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
            // Without a local HEAD ref, only the remote can identify its default;
            // a conventional name may be a feature branch.
            if (branch === null) {
              branch = yield* git
                .execute({
                  operation: "StorageCleanup.resolveDefaultBranch",
                  cwd: repositoryCwd,
                  args: ["ls-remote", "--symref", "--", remote, "HEAD"],
                  timeoutMs: 20_000,
                })
                .pipe(
                  Effect.map(
                    (result) =>
                      /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(result.stdout)?.[1] ?? null,
                  ),
                  Effect.orElseSucceed(() => null),
                );
            }
            defaultBranches.set(defaultBranchKey, branch);
          }
          if (branch === null) return keep("default branch is unavailable");
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          const integrated = ancestor.exitCode === 0;
          eligible = integrated && settings.worktreeUnchanged;
          if (eligible) removalReason = "no commits beyond the default branch";
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true },
            );
            eligible = storageCleanupPullRequestMerged(pullRequest, {
              branch: thread.branch,
              defaultBranch: branch,
              headSha: head.commitSha,
              integrated,
            });
            if (eligible) removalReason = "pull request was merged";
          }
        }
        if (!eligible)
          return keep(
            !deleted && settings.worktreeAfterDays !== null
              ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} of ${settings.worktreeAfterDays} days`
              : settings.worktreeSettledAfterDays !== null
                ? settledFor === null
                  ? "not settled"
                  : `settled for ${settledDays} of ${settings.worktreeSettledAfterDays} days`
                : settings.worktreeOnMerge
                  ? "not merged"
                  : "has commits beyond the default branch",
          );
        // Re-read this path's threads and sessions so new activity cancels removal; full per-worktree snapshots take seconds.
        const blockedSinceCheck = Effect.fnUntraced(function* () {
          const latestProjects = yield* projectStore.listShells();
          if (yield* containsProjectRoot(worktreePath, [project, ...latestProjects]))
            return "contains a project checkout";
          const latest = (yield* projections.getThreadWorktreePaths({
            includeArchived: true,
          })).filter((entry) => path.resolve(entry.worktreePath) === worktreePath);
          if (hasTerminal(worktreePath)) return "open terminal";
          if (deleted) {
            if (
              !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                .worktreeOnDelete
            )
              return "thread or cleanup settings changed since check";
            // Durable deletion cleanup must succeed or be explicitly cancelled before removing its checkout.
            const pendingCleanup = yield* sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `.pipe(NodeSqliteClient.readOnly);
            if (pendingCleanup.length > 0) return "thread deletion is still pending";
          }
          const latestShells = yield* Effect.forEach(latest, (entry) =>
            projections.getThreadShell(entry.threadId),
          );
          const latestGroup = latestShells.filter((shell) => shell !== null);
          const latestOwner = worktreeOwner(deleted ? [thread, ...latestGroup] : latestGroup);
          if (
            latestGroup.length !== group.length ||
            latestOwner?.id !== thread.id ||
            latestOwner?.branch !== thread.branch ||
            latestGroup.some((shell) => {
              const previous = group.find((member) => member.id === shell.id);
              return (
                previous === undefined ||
                shell.branch !== thread.branch ||
                !Equal.equals(shell.settledAt, previous.settledAt) ||
                (shell.settledAt !== null && !Equal.equals(shell.updatedAt, previous.updatedAt)) ||
                !storageCleanupThreadIdle(shell, now) ||
                path.resolve(shell.worktreePath!) !== worktreePath ||
                storageCleanupActivityAt(shell) !== storageCleanupActivityAt(previous)
              );
            })
          )
            return "thread activity or shared worktree changed since check";
          // Sessions can outlive their run and can be shared across app threads.
          const sessionRows = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_provider_sessions
            WHERE status != 'stopped'
          `.pipe(NodeSqliteClient.readOnly);
          const sessions = yield* Effect.forEach(sessionRows, (row) =>
            decodeCleanupSession(row.payload_json),
          );
          // Ready persisted sessions may have released their runtime; only live sessions protect the path.
          for (const session of sessions) {
            const cwd = path.resolve(session.cwd);
            if (
              (cwd === worktreePath || inside(worktreePath, cwd)) &&
              (yield* providerSessions.isLive(session.id))
            )
              return "provider session is still open";
          }
          return null;
        });
        const blocked = yield* blockedSinceCheck();
        if (blocked !== null) return keep(blocked);
        const bytes = yield* measureWorktree(worktreePath);
        const blockedWhileMeasuring = yield* blockedSinceCheck();
        if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed since check");
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return keep("commit changed since check");
        const finalChanges = yield* localChangesReason(worktreePath, settings);
        if (finalChanges !== null) return keep(finalChanges);
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return keep("settings changed since check");
        // Clean only untracked files. Ordinary worktrees retain Git's final tracked-edit check.
        if (settings.worktreeKeepWhen === "tracked-changes")
          yield* cleanupGit(worktreePath, ["clean", "-ffdx"], "git clean");
        const submodules = yield* submoduleRemoval(worktreePath, settings);
        if (submodules.reason !== null) return keep(submodules.reason);
        if (submodules.force) {
          const changes = yield* localChangesReason(worktreePath, settings);
          if (changes !== null) return keep(changes);
        }
        yield* removeLinkedWorktree({
          operation: "StorageCleanup.cleanupGit",
          cwd: project.workspaceRoot,
          worktreePath,
          // Git requires force for submodules; recursive checks above cannot make removal atomic.
          force: submodules.force,
          execute: git.execute,
          run: (args) => cleanupGit(project.workspaceRoot, [...args], "git worktree remove"),
        });
        entries.push({ ...entry, outcome: "removed", reason: sentence(removalReason), bytes });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch/path so ProviderTurnStartService can recreate the checkout on resume.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              ...entry,
              outcome: "failed",
              reason: cleanupFailureReason(error),
            });
            yield* Effect.logWarning("storage cleanup failed for worktree", {
              threadId: thread.id,
              error,
            });
          }),
        ),
      );
    }
    yield* reportOrphanWorktrees(
      roots,
      yield* projectStore.list({ includeDeleted: true }),
      entries,
    );
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
    removed: { files: number; bytes: number },
  ) {
    if (days === null || !(yield* fs.exists(root))) return removed;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return removed;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
            removed.files++;
            removed.bytes += Number(stat.size);
          }
        }
      }
    });
    yield* visit(realRoot);
    return removed;
  });

  const reportRef = yield* SubscriptionRef.make<StorageCleanupReport | null>(null);

  const cleanMergedBranches = Effect.fn("StorageCleanup.cleanMergedBranches")(function* (
    settings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
  ) {
    if (
      !settings.autoDeleteMergedBranches &&
      !Object.values(settings.projectSettingsOverrides).some(
        (override) => override.autoDeleteMergedBranches === true,
      )
    )
      return;
    const snapshot = yield* readThreads();
    const repositories = new Set<string>();
    const enabled = (settings: ServerSettings, projectId: ProjectId) => {
      const effective = resolveProjectSettings(settings, projectId).settings;
      return effective.worktreeCleanup?.mode !== "off" && effective.autoDeleteMergedBranches;
    };
    const readBranches = Effect.fn("StorageCleanup.readLocalBranches")(function* (
      cwd: string,
      branch?: string,
    ) {
      const output = yield* git.execute({
        operation: "StorageCleanup.readLocalBranches",
        cwd,
        args: [
          "for-each-ref",
          "--format=%(refname:strip=2)%00%(objectname)%00%(worktreepath)%00",
          branch === undefined ? "refs/heads/" : `refs/heads/${branch}`,
        ],
      });
      if (output.stdoutTruncated)
        return yield* new GitCommandError({
          operation: "StorageCleanup.readLocalBranches",
          command: "git for-each-ref",
          cwd,
          detail: "Branch inspection exceeded the output limit.",
        });
      const fields = output.stdout.split("\0");
      const branches: Array<{ name: string; sha: string; worktreePath: string | null }> = [];
      for (let index = 0; index + 2 < fields.length; index += 3) {
        const name = fields[index]!.trim();
        if (!name) continue;
        branches.push({ name, sha: fields[index + 1]!, worktreePath: fields[index + 2] || null });
      }
      return branches;
    });
    for (const project of snapshot.projects) {
      if (!enabled(settings, project.id)) continue;
      const cwd = project.workspaceRoot;
      const projectEntry = {
        kind: "branch" as const,
        outcome: "failed" as const,
        reason: "",
        path: null,
        projectPath: cwd,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      };
      yield* Effect.gen(function* () {
        const repository = yield* git.execute({
          operation: "StorageCleanup.inspectRepository",
          cwd,
          args: ["rev-parse", "--is-inside-work-tree"],
          allowNonZeroExit: true,
        });
        if (repository.exitCode !== 0 || repository.stdout.trim() !== "true") return;
        const common = (yield* git.execute({
          operation: "StorageCleanup.repository",
          cwd,
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        })).stdout.trim();
        if (repositories.has(common)) return;
        repositories.add(common);
        const remote = yield* git
          .resolvePrimaryRemoteName(cwd)
          .pipe(Effect.orElseSucceed(() => null));
        const baseRefs = ["refs/heads/main", "refs/heads/master"];
        if (remote !== null) {
          const heads = yield* git.execute({
            operation: "StorageCleanup.mainBranches",
            cwd,
            args: ["ls-remote", "--heads", "--", remote, "refs/heads/main", "refs/heads/master"],
            timeoutMs: 20_000,
          });
          if (heads.stdoutTruncated) return;
          for (const name of ["main", "master"]) {
            if (!heads.stdout.split(/\r?\n/).some((line) => line.endsWith(`\trefs/heads/${name}`)))
              continue;
            yield* git.fetchRemoteTrackingBranch({ cwd, remoteName: remote, remoteBranch: name });
            baseRefs.push(`refs/remotes/${remote}/${name}`);
          }
        }
        const bases: string[] = [];
        for (const revision of baseRefs) {
          const resolved = yield* git.resolveCommit({ cwd, revision }).pipe(Effect.option);
          if (Option.isSome(resolved)) bases.push(resolved.value.commitSha);
        }
        if (bases.length === 0) return;
        let changed = false;
        for (const branch of yield* readBranches(cwd)) {
          if (isMainOrMasterBranch(branch.name)) continue;
          const entry: StorageCleanupReportEntry = {
            ...projectEntry,
            outcome: "kept",
            path: branch.name,
          };
          const keep = (reason: string) => entries.push({ ...entry, reason: sentence(reason) });
          yield* Effect.gen(function* () {
            if (
              branch.worktreePath !== null &&
              (yield* containsProjectRoot(branch.worktreePath, snapshot.projects))
            )
              return keep("contains a project checkout");
            let merged = false;
            for (const base of bases) {
              const ancestor = yield* git.execute({
                operation: "StorageCleanup.mergedBranch",
                cwd,
                args: ["merge-base", "--is-ancestor", branch.sha, base],
                allowNonZeroExit: true,
              });
              if (ancestor.exitCode === 0) {
                merged = true;
                break;
              }
              if (ancestor.exitCode !== 1) return keep("merge inspection failed");
            }
            if (!merged) {
              const pr = yield* gitManager.branchPullRequest(
                { cwd, branch: branch.name },
                { freshGitState: true },
              );
              merged =
                pr?.state === "merged" &&
                isMainOrMasterBranch(pr.baseRef) &&
                pr.headRef === branch.name &&
                pr.headSha === branch.sha;
            }
            if (!merged) return keep("not merged into main or master");
            const protection = Effect.fn("StorageCleanup.mergedBranchProtection")(function* () {
              const currentSettings = yield* settingsService.getSettings;
              if (!enabled(currentSettings, project.id)) return "automatic cleanup is disabled";
              const latestProjects = yield* projectStore.listShells();
              const worktreePath = branch.worktreePath;
              const workspaceReferences = yield* sql<{
                workspacePath: string;
                commonDir: string | null;
                branch: string | null;
              }>`
                SELECT json_extract(r.value, '$.checkoutRoot') AS "workspacePath",
                  json_extract(r.value, '$.identity.commonDir') AS "commonDir",
                  json_extract(b.value, '$.launchBranch') AS branch
                FROM orchestration_v2_projection_workspace_revisions w,
                  json_each(w.payload_json, '$.resources') r
                LEFT JOIN json_each(w.payload_json, '$.bindings') b
                  ON json_extract(b.value, '$.resourceId') = json_extract(r.value, '$.id')
                UNION SELECT json_extract(r.value, '$.path'),
                  json_extract(r.value, '$.source.identity.commonDir'),
                  json_extract(r.value, '$.branch')
                FROM workspace_preparations w, json_each(w.payload_json, '$.resources') r
                UNION SELECT json_extract(r.value, '$.sourcePath'), NULL, NULL
                FROM projection_projects p, json_each(p.workspace_config_json, '$.roots') r
                WHERE p.deleted_at IS NULL
              `.pipe(NodeSqliteClient.readOnly);
              for (const reference of workspaceReferences) {
                if (
                  reference.commonDir !== null &&
                  pathKey(reference.commonDir) === pathKey(common) &&
                  reference.branch === branch.name
                )
                  return "branch is retained by a multi-repository workspace";
                if (
                  worktreePath !== null &&
                  (yield* containsProjectRoot(worktreePath, [
                    { workspaceRoot: reference.workspacePath },
                  ]))
                )
                  return "worktree belongs to a multi-repository workspace";
              }
              if (worktreePath !== null) {
                if (yield* containsProjectRoot(worktreePath, latestProjects))
                  return "contains a project checkout";
                if (hasTerminal(worktreePath)) return "open terminal";
                const real = yield* fs.realPath(worktreePath);
                const parent = yield* fs.realPath(path.dirname(worktreePath));
                if (real !== path.join(parent, path.basename(worktreePath)))
                  return "worktree is a symbolic link";
                if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
                  return "not a linked worktree";
                const gitDirectory = (yield* git.execute({
                  operation: "StorageCleanup.worktreeLock",
                  cwd: worktreePath,
                  args: ["rev-parse", "--absolute-git-dir"],
                })).stdout.trim();
                if (yield* fs.exists(path.join(gitDirectory, "locked")))
                  return "worktree is locked";
                if (yield* branchChanged(worktreePath, branch.name))
                  return "repository or branch changed";
                const changes = yield* localChangesReason(worktreePath, {
                  ...resolveWorktreeCleanup(currentSettings, project.id),
                  worktreeKeepWhen: "uncommitted-changes",
                });
                if (changes !== null) return changes;
              }
              const paths = yield* projections.getThreadWorktreePaths({ includeArchived: true });
              const ids = new Set([
                ...snapshot.threads
                  .filter(
                    (thread) => thread.projectId === project.id && thread.branch === branch.name,
                  )
                  .map((thread) => thread.id),
                ...paths
                  .filter(
                    (thread) =>
                      worktreePath !== null &&
                      pathKey(thread.worktreePath) === pathKey(worktreePath),
                  )
                  .map((thread) => thread.threadId),
              ]);
              const related = (yield* Effect.forEach(ids, (id) =>
                projections.getThreadShell(id),
              )).filter((thread) => thread !== null);
              const sharing = related.filter(
                (thread) =>
                  worktreePath !== null &&
                  thread.worktreePath !== null &&
                  pathKey(thread.worktreePath) === pathKey(worktreePath),
              );
              if (worktreePath !== null && sharing.length === 0) {
                const modified = Option.getOrNull((yield* fs.stat(worktreePath)).mtime);
                if (modified === null || modified.getTime() > now - ORPHAN_WORKTREE_GRACE_MS)
                  return "worktree was created recently";
              }
              if (sharing.length > 1 && worktreeOwner(sharing) === undefined)
                return "worktree is shared by independent threads";
              for (const thread of related) {
                if (!enabled(currentSettings, thread.projectId))
                  return "cleanup is disabled for a related thread's project";
                if (!threadIdle(thread, now)) return "thread is running or has pending work";
                if (now - storageCleanupActivityAt(thread) < SETTLE_SCRIPT_GRACE_MS)
                  return "thread was active moments ago";
              }
              if (worktreePath !== null) {
                const rows = yield* sql<{ payload_json: string }>`
                  SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'
                `.pipe(NodeSqliteClient.readOnly);
                for (const row of rows) {
                  const session = yield* decodeCleanupSession(row.payload_json);
                  if (
                    (pathKey(session.cwd) === pathKey(worktreePath) ||
                      inside(worktreePath, session.cwd)) &&
                    (yield* providerSessions.isLive(session.id))
                  )
                    return "provider session is still open";
                }
              }
              const latest = (yield* readBranches(cwd, branch.name)).find(
                (candidate) => candidate.name === branch.name,
              );
              if (latest?.sha !== branch.sha || latest.worktreePath !== worktreePath)
                return "branch or checkout changed since check";
              return null;
            });
            const remove = Effect.gen(function* () {
              const blocked = yield* protection();
              if (blocked !== null) return keep(blocked);
              if (branch.worktreePath !== null) {
                yield* git.removeWorktree({ cwd, path: branch.worktreePath, force: false });
                changed = true;
                entries.push({
                  ...entry,
                  kind: "worktree",
                  path: branch.worktreePath,
                  outcome: "removed",
                  reason: "Merged into main or master",
                });
              }
              const latest = (yield* readBranches(cwd, branch.name)).find(
                (candidate) => candidate.name === branch.name,
              );
              if (latest?.sha !== branch.sha || latest.worktreePath !== null)
                return keep("branch or checkout changed since check");
              if (!enabled(yield* settingsService.getSettings, project.id))
                return keep("automatic cleanup is disabled");
              yield* git.deleteLocalBranch({
                cwd,
                refName: branch.name,
                expectedHeadSha: branch.sha,
              });
              changed = true;
              entries.push({ ...entry, outcome: "removed", reason: "Merged into main or master" });
            });
            yield* withWorkspaceLease(branch.worktreePath ?? cwd, remove);
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                entries.push({
                  ...entry,
                  outcome: "failed",
                  reason: cleanupFailureReason(error),
                }),
              ),
            ),
          );
        }
        if (changed) yield* gitManager.invalidateStatus(cwd);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            entries.push({
              ...projectEntry,
              reason: cleanupFailureReason(error),
            }),
          ),
        ),
      );
    }
  });

  const sweep = Effect.fn("StorageCleanup.sweep")(function* (
    trigger: StorageCleanupReport["trigger"],
  ) {
    const now = yield* Clock.currentTimeMillis;
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const entries: StorageCleanupReportEntry[] = [];
    yield* cleanMergedBranches(serverSettings, now, entries).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          entries.push({
            kind: "branch",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          }),
        ),
      ),
    );
    yield* cleanWorktrees(serverSettings, now, entries).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          entries.push({
            kind: "worktree",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          });
          yield* Effect.logWarning("worktree cleanup failed", { error });
        }),
      ),
    );
    for (const category of [
      {
        kind: "browser-artifacts" as const,
        root: config.browserArtifactsDir,
        days: settings.browserArtifactsAfterDays,
        label: "browser artifacts",
      },
      {
        kind: "logs" as const,
        root: config.logsDir,
        days: settings.logsAfterDays,
        label: "rotated logs",
      },
    ]) {
      if (category.days === null) continue;
      const removed = { files: 0, bytes: 0 };
      yield* cleanFiles(category.root, category.days, now, category.kind === "logs", removed).pipe(
        Effect.map(({ files, bytes }) =>
          entries.push({
            kind: category.kind,
            outcome: files > 0 ? "removed" : "kept",
            reason: files === 0 ? "No expired files" : `Removed ${files} ${category.label}`,
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: files > 0 ? bytes : null,
            files: files > 0 ? files : null,
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              kind: category.kind,
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: removed.files > 0 ? removed.bytes : null,
              files: removed.files > 0 ? removed.files : null,
            });
            yield* Effect.logWarning("storage file cleanup failed", { kind: category.kind, error });
          }),
        ),
      );
    }
    const counts = { removed: 0, kept: 0, failed: 0 };
    let bytesFreed = 0;
    for (const entry of entries) {
      counts[entry.outcome]++;
      if (entry.outcome !== "kept") bytesFreed += entry.bytes ?? 0;
    }
    const priority = (entry: StorageCleanupReportEntry) =>
      entry.outcome === "failed"
        ? 0
        : entry.outcome === "removed"
          ? 1
          : entry.kind === "worktree" && entry.threadId === null
            ? 2
            : 3;
    const latestReport: StorageCleanupReport = {
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries.sort((a, b) => priority(a) - priority(b)).slice(0, REPORT_ENTRY_LIMIT),
      counts,
      bytesFreed,
      omittedCount: Math.max(0, entries.length - REPORT_ENTRY_LIMIT),
    };
    yield* SubscriptionRef.set(reportRef, latestReport);
    return latestReport;
  });
  type MergedBase = Pick<
    PullRequestService.PullRequestMergeEvent,
    "projectId" | "url" | "number" | "baseBranch"
  >;
  const synchronizedMerges = new Set<string>();
  const synchronizeMergedBase = Effect.fn("StorageCleanup.synchronizeMergedBase")(
    function* (merge: MergedBase) {
      const branch = merge.baseBranch;
      if (branch !== "main" && branch !== "master") return;
      const project = (yield* projectStore.listShells()).find(
        (entry) => entry.id === merge.projectId,
      );
      const repository = GitManager.pullRequestRepositoryKey(merge.url);
      if (project === undefined || repository === null) return;
      const cwd = project.workspaceRoot;
      const execute = (args: string[], directory = cwd) =>
        git.execute({
          operation: "StorageCleanup.synchronizeMergedBase",
          cwd: directory,
          args,
        });
      const readBranch = Effect.fn("StorageCleanup.readMergedBase")(function* () {
        const result = yield* execute([
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(worktreepath)%00%(upstream:remotename)%00%(upstream:remoteref)",
          `refs/heads/${branch}`,
        ]);
        if (result.stdoutTruncated) return null;
        const [ref, sha, checkout, remote, upstream] = result.stdout.trimEnd().split("\0");
        return ref === `refs/heads/${branch}` && sha !== undefined
          ? { sha, checkout: checkout || null, remote: remote || null, upstream: upstream || null }
          : null;
      });
      const before = yield* readBranch();
      if (
        before === null ||
        (before.upstream !== null && before.upstream !== `refs/heads/${branch}`)
      )
        return;
      const matches = Effect.fn("StorageCleanup.matchesMergedRepository")(function* (
        remote: string,
      ) {
        const url = yield* git.readConfigValue(cwd, `remote.${remote}.url`);
        return (
          url !== null &&
          sourceControlDefinitions.canonicalRepositoryKey(
            sourceControlDefinitions.repositoryKeyFromRemote(url),
          ) === sourceControlDefinitions.canonicalRepositoryKey(repository)
        );
      });
      let remote = before.remote;
      if (remote !== null) {
        if (!(yield* matches(remote))) return;
      } else {
        const names = (yield* execute(["remote"])).stdout.trim().split(/\r?\n/).filter(Boolean);
        const matching = yield* Effect.filter(names, matches);
        remote = matching.includes("origin")
          ? "origin"
          : matching.length === 1
            ? matching[0]!
            : null;
      }
      if (remote === null) return;
      const common = (yield* execute([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])).stdout.trim();
      const key = `${common}\0${repository}\0${merge.number}\0${branch}`;
      if (synchronizedMerges.has(key)) return;
      yield* git.fetchRemoteTrackingBranch({ cwd, remoteName: remote, remoteBranch: branch });
      const target = (yield* git.resolveCommit({
        cwd,
        revision: `refs/remotes/${remote}/${branch}`,
      })).commitSha;
      const result = yield* withWorkspaceLease(
        before.checkout ?? cwd,
        Effect.gen(function* () {
          const current = yield* readBranch();
          if (
            current === null ||
            current.sha !== before.sha ||
            current.checkout !== before.checkout
          )
            return "branch changed";
          if (current.sha === target) return "up to date";
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.synchronizeMergedBase",
            cwd,
            args: ["merge-base", "--is-ancestor", current.sha, target],
            allowNonZeroExit: true,
          });
          if (ancestor.exitCode !== 0) return "local commits or ancestry unavailable";
          if (current.checkout !== null) {
            const checkout = current.checkout;
            if (hasTerminal(checkout)) return "open terminal";
            const snapshot = yield* readThreads();
            const roots = new Map(
              snapshot.projects.map((entry) => [entry.id, entry.workspaceRoot]),
            );
            const now = yield* Clock.currentTimeMillis;
            if (
              snapshot.threads.some((thread) => {
                const workspace = thread.worktreePath ?? roots.get(thread.projectId);
                return (
                  workspace !== undefined &&
                  (pathKey(workspace) === pathKey(checkout) || inside(checkout, workspace)) &&
                  !threadIdle(thread, now)
                );
              })
            )
              return "active work";
            const sessions = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'`.pipe(
              NodeSqliteClient.readOnly,
            );
            for (const row of sessions) {
              const session = yield* decodeCleanupSession(row.payload_json);
              if (
                (pathKey(session.cwd) === pathKey(checkout) || inside(checkout, session.cwd)) &&
                (yield* providerSessions.isLive(session.id))
              )
                return "live provider session";
            }
            const directory = (yield* execute(
              ["rev-parse", "--absolute-git-dir"],
              checkout,
            )).stdout.trim();
            if (yield* fs.exists(path.join(directory, "locked"))) return "locked worktree";
            const changes = yield* execute(
              ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
              checkout,
            );
            if (changes.stdoutTruncated || changes.stdout.length > 0) return "uncommitted changes";
            if (yield* branchChanged(checkout, branch)) return "checkout changed";
            yield* execute(
              [
                "merge",
                "--ff-only",
                "--no-edit",
                "--no-autostash",
                "--no-overwrite-ignore",
                target,
              ],
              checkout,
            );
          } else {
            yield* execute(["update-ref", `refs/heads/${branch}`, target, current.sha]);
          }
          yield* gitManager.invalidateStatus(cwd);
          if (current.checkout !== null && current.checkout !== cwd)
            yield* gitManager.invalidateStatus(current.checkout);
          return "updated";
        }),
      );
      if (result === "updated" || result === "up to date") {
        if (synchronizedMerges.size >= REPORT_ENTRY_LIMIT)
          synchronizedMerges.delete(synchronizedMerges.values().next().value!);
        synchronizedMerges.add(key);
      }
      yield* Effect.logInfo("Post-merge local base synchronization", { branch, result });
    },
    Effect.catch((error) =>
      Effect.logWarning("Post-merge local base synchronization failed", { errorTag: error._tag }),
    ),
  );

  const automaticSweepQueued = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(
    ({
      completion,
      merge,
    }: {
      completion?: Deferred.Deferred<StorageCleanupReport, ServerSettingsError>;
      merge?: MergedBase;
    }) =>
      (completion === undefined ? Ref.set(automaticSweepQueued, false) : Effect.void).pipe(
        Effect.andThen(merge === undefined ? Effect.void : synchronizeMergedBase(merge)),
        Effect.andThen(sweep(completion === undefined ? "automatic" : "manual")),
        Effect.exit,
        Effect.flatMap((exit) =>
          completion === undefined
            ? exit.pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning("storage cleanup failed", { cause }),
                ),
              )
            : Deferred.done(completion, exit).pipe(Effect.asVoid),
        ),
      ),
  );
  const requestSweep = Ref.getAndSet(automaticSweepQueued, true).pipe(
    Effect.flatMap((queued) => (queued ? Effect.void : worker.enqueue({}))),
  );
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport, ServerSettingsError>();
    yield* worker.enqueue({ completion });
    return yield* Deferred.await(completion);
  });

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const merges = yield* pullRequests.subscribeMerges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      requestSweep.pipe(
        Effect.andThen(worker.drain),
        Effect.repeat(Schedule.spaced("5 minutes")),
        Effect.asVoid,
      ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          settings.autoDeleteMergedBranches === lastSettings.autoDeleteMergedBranches &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return requestSweep;
      }),
    );
    yield* forkParked(Stream.runForEach(merges, (merge) => worker.enqueue({ merge })));
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        event.type === "thread.pull-request-link-updated" &&
        event.payload.snapshot?.state === "merged"
          ? projections.getThreadShell(event.threadId).pipe(
              Effect.flatMap((thread) =>
                thread === null
                  ? Effect.void
                  : worker.enqueue({
                      merge: {
                        projectId: thread.projectId,
                        url: event.payload.url,
                        number: event.payload.number,
                        baseBranch: event.payload.snapshot!.baseBranch,
                      },
                    }),
              ),
            )
          : (event.type === "thread.deleted" ||
                (event.type === "provider-session.updated" &&
                  (event.payload.status === "stopped" || event.payload.status === "error"))) &&
              anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
            ? requestSweep
            : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  yield* start();
  return StorageCleanup.of({
    runNow,
    latestReport: SubscriptionRef.get(reportRef),
    reports: SubscriptionRef.changes(reportRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(StorageCleanup, make).pipe(
  Layer.provide(
    WorkspaceCleanup.layer.pipe(
      Layer.provide(WorkspaceRepositoryResolver.layer.pipe(Layer.provide(NodeCrypto.layer))),
    ),
  ),
);
