import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";
import { withoutRemoteUrlCredentials } from "@t3tools/shared/cloneUrl";
import { canonicalRepositoryPath, normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import {
  isLocalRemoteUrl,
  selectRequirementRemote,
  sourceControlDefinitions,
} from "../sourceControl/sourceControlDefinitions.ts";
import { explicitBareRepositoryEnv, unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
// Minute-by-minute sweeps need cached hits; clone, publish and PR discovery force refresh.
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: <E = never>(
      cwd: string,
      options?: {
        readonly refresh?: boolean;
        readonly remoteOnly?: boolean;
        readonly onUnavailable?: (
          remote: RepositoryIdentity | null,
        ) => Effect.Effect<RepositoryIdentity | null, E>;
      },
    ) => Effect.Effect<RepositoryIdentity | null, E>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

// `git remote -v` applies url.*.insteadOf, which can point a GitHub remote at a proxy or mirror.
// A configured URL that names a forge wins; a shorthand like `gh:` is known only once rewritten.
function parseConfiguredRemoteUrls(config: string): Map<string, string> {
  const urls = new Map<string, string>();
  for (const line of config.split("\n")) {
    const match = /^remote\.(\S+)\.url (.+)$/u.exec(line);
    // Git fetches from the first of several configured URLs.
    if (match?.[1] && match[2] && !urls.has(match[1])) urls.set(match[1], match[2]);
  }
  return urls;
}

function parseRemoteFetchUrls(stdout: string, configuredUrls: ReadonlyMap<string, string>) {
  const remotes = new Map<string, string>();
  const fetchRemotes = new Map<string, string>();
  let hasLocalOrigin = false;
  for (const line of stdout.split(/\r?\n/)) {
    // Git uses a tab before the URL and one space before the direction; both can occur in URLs.
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\t(.+) \((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(line);
    if (!match) continue;
    const [, remoteName = "", fetchUrl = "", direction = ""] = match;
    if (direction !== "fetch" || !remoteName || !fetchUrl) continue;
    fetchRemotes.set(remoteName, fetchUrl);
    if (remoteName === "origin" && isLocalRemoteUrl(fetchUrl)) hasLocalOrigin = true;
    const configuredUrl = configuredUrls.get(remoteName);
    const remoteUrl =
      configuredUrl !== undefined &&
      (sourceControlDefinitions.recognizeRemote(configuredUrl)?.kind ?? "unknown") !== "unknown"
        ? configuredUrl
        : fetchUrl;
    if (isLocalRemoteUrl(remoteUrl)) continue;
    // The identity names the remote, not the login used to reach it.
    remotes.set(remoteName, withoutRemoteUrlCredentials(remoteUrl));
  }
  return { remotes, fetchRemotes, hasLocalOrigin };
}

// `gh repo set-default` marks one remote with `base`, or with OWNER/REPO when it picked a
// parent repository. gh reads PRs from that repository, so the identity follows the mark when
// a remote fetches it. The locator must name a real remote: review checkouts fetch through it.
function pickMarkedRemote(
  remotes: ReadonlyMap<string, string>,
  resolved: string,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  const marks = resolved.split("\n").flatMap((line) => {
    const match = /^remote\.(.+)\.gh-resolved\s+(\S+)$/u.exec(line.trim());
    const remoteUrl = match?.[1] === undefined ? undefined : remotes.get(match[1]);
    return match?.[1] && match[2] && remoteUrl
      ? [{ remoteName: match[1], remoteUrl, value: match[2] }]
      : [];
  });
  // gh's choice is ambiguous with several marks; GitHubSourceControlProvider ignores them too.
  const [mark, ...others] = marks;
  if (!mark || others.length > 0) return null;
  if (mark.value === "base") return { remoteName: mark.remoteName, remoteUrl: mark.remoteUrl };
  // Compare hosts with HTTP ports kept: one hostname can serve separate forges on two ports.
  const host = parseGitRemoteHost(mark.remoteUrl)?.host;
  const markedPath = mark.value.toLowerCase();
  const [remoteName, remoteUrl] =
    [...remotes.entries()].find(
      ([, url]) =>
        parseGitRemoteHost(url)?.host === host &&
        normalizeGitRemoteUrl(url).split("/").slice(1).join("/") === markedPath,
    ) ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
  resolved: string,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  const marked = pickMarkedRemote(remotes, resolved);
  if (marked) return marked;

  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function repositoryPathOf(canonicalKey: string, remoteUrl: string): string {
  const canonicalPath = canonicalKey.split("/").slice(1).join("/");
  const displayPath = repositoryPathFromRemoteUrl(remoteUrl);
  if (displayPath === null) return canonicalPath;
  // A host that names repositories literally keeps the `.git` the display path drops.
  return (
    [displayPath, `${displayPath}.git`].find(
      (path) => canonicalRepositoryPath(path) === canonicalRepositoryPath(canonicalPath),
    ) ?? canonicalPath
  );
}

// A leading `-` on the user or host would be read by ssh as an option.
const SSH_REMOTE = /^((?:ssh:\/\/)?)((?:[^-@/:][^@/:]*@)?)([A-Za-z0-9][A-Za-z0-9._-]*)([:/].*)$/su;
const SSH_HOST_NAME = /^[a-z0-9][a-z0-9.-]*$/u;
const IPV4 = /^[\d.]+$/u;

// Keys an SSH remote by the host its ssh config alias (`Host github.com-personal`) points at.
// A dotted host may have a separate SSH endpoint; only a public forge or another configured
// remote's host confirms the replacement. `ssh -G` opens no connection.
const sshResolvedRemoteUrl = Effect.fn("RepositoryIdentityResolver.sshResolvedRemoteUrl")(
  function* (remoteUrl: string, remotes: ReadonlyMap<string, string>) {
    const match = isSshRemoteUrl(remoteUrl) ? SSH_REMOTE.exec(remoteUrl.trim()) : null;
    if (!match) return remoteUrl;
    const [, scheme = "", user = "", host = "", rest = ""] = match;
    if (sourceControlDefinitions.findByPublicHost(host)) return remoteUrl;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner
      .run({
        command: "ssh",
        args: ["-G", `${user}${host}`],
        timeout: Duration.seconds(5),
        maxOutputBytes: 64_000,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (result._tag === "None" || result.value.code !== 0) return remoteUrl;
    const hostName = result.value.stdout
      .split("\n")
      .find((line) => line.startsWith("hostname "))
      ?.slice("hostname ".length)
      .trim()
      .toLowerCase();
    if (
      hostName === undefined ||
      !SSH_HOST_NAME.test(hostName) ||
      IPV4.test(hostName) ||
      hostName === host.toLowerCase()
    )
      return remoteUrl;
    const resolvedUrl = `${scheme}${user}${hostName}${rest}`;
    if (
      host.includes(".") &&
      !sourceControlDefinitions.findByPublicHost(
        sourceControlDefinitions.repositoryKeyFromRemote(resolvedUrl).split("/")[0]!,
      ) &&
      !Array.from(remotes.values()).some(
        (url) =>
          (/^https?:\/\//iu.test(url) || isSshRemoteUrl(url)) &&
          parseGitRemoteHost(url)?.host === hostName,
      )
    ) {
      return remoteUrl;
    }
    return resolvedUrl;
  },
);

function buildRepositoryOrigin(
  originUrl: string | undefined,
  originKeyUrl: string | undefined,
  canonicalKey: string,
): RepositoryIdentity["origin"] {
  if (!originUrl) return undefined;
  const originKey = sourceControlDefinitions.repositoryKeyFromRemote(originKeyUrl ?? originUrl);
  if (originKey === canonicalKey) return undefined;
  const displayName = repositoryPathOf(originKey, originUrl);
  return { canonicalKey: originKey, remoteUrl: originUrl, ...(displayName ? { displayName } : {}) };
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly keyUrl: string;
  readonly originUrl: string | undefined;
  readonly originKeyUrl: string | undefined;
  readonly hasLocalOrigin: boolean;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = sourceControlDefinitions.repositoryKeyFromRemote(input.keyUrl);
  const sourceControlProvider = sourceControlDefinitions.recognizeRemote(input.keyUrl);
  const repositoryPath = repositoryPathOf(canonicalKey, input.remoteUrl);
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);
  const origin = buildRepositoryOrigin(input.originUrl, input.originKeyUrl, canonicalKey);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
    ...(origin ? { origin } : {}),
    ...(input.hasLocalOrigin ? { hasLocalOrigin: true } : {}),
  };
}

class RepositoryIdentityCacheKey extends Data.Class<{
  readonly rootPath: string;
  readonly isBare: boolean;
}> {}

const gitEnv = (platform: NodeJS.Platform): NodeJS.ProcessEnv => ({
  ...unsetInheritedRepositoryEnv(process.env, platform),
  ...explicitBareRepositoryEnv(process.env, platform),
  LC_ALL: "C",
});

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = gitEnv(yield* HostProcess.Platform);

    // `git -C` cannot enter a missing folder or a file, so every probe below would fail.
    const isFolder = yield* fileSystem.stat(cwd).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.orElseSucceed(() => true),
    );
    if (!isFolder) return undefined;

    // git is always a real executable; cmd shell mode would split spaced paths on re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-cdup", "--show-toplevel"],
        env,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.timedOut) {
      return undefined;
    }
    const hasEntry = (target: string) =>
      fileSystem.lstat(target).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
        Effect.orElseSucceed(() => true),
      );
    const hasSkippedCheckout = Effect.fn("RepositoryIdentityResolver.hasSkippedCheckout")(
      function* (levels = Infinity) {
        if (levels === 0) return false;
        const physical = yield* fileSystem.realPath(cwd).pipe(Effect.option);
        if (physical._tag === "None") return true;
        if (levels === Infinity) {
          const start = physical.value.split(path.sep).join("/");
          const stopBefore = (ancestor: string) => {
            const prefix = `${ancestor.split(path.sep).join("/").replace(/\/$/u, "")}/`;
            if (start.startsWith(prefix) && start.length > prefix.length)
              levels = Math.min(levels, start.slice(prefix.length).split("/").length);
          };
          const mount =
            /^fatal: not a git repository \(or any parent up to mount point ([\s\S]+?)\)\r?\nStopping at filesystem boundary /mu.exec(
              topLevelResult.value.stderr,
            )?.[1];
          if (mount) stopBefore(mount);
          const ceilings = (yield* HostProcess.Environment).GIT_CEILING_DIRECTORIES;
          let resolveSymlinks = true;
          for (const entry of ceilings?.split(path.sep === "\\" ? ";" : ":") ?? []) {
            if (!entry) resolveSymlinks = false;
            else if (path.isAbsolute(entry)) {
              const ceiling = resolveSymlinks
                ? yield* fileSystem.realPath(entry).pipe(Effect.orElseSucceed(() => undefined))
                : entry;
              if (ceiling) stopBefore(ceiling);
            }
          }
        }
        let directory = physical.value;
        for (let depth = 0; depth < levels; depth++) {
          if (yield* hasEntry(path.join(directory, ".git"))) return true;
          const config = path.join(directory, "config");
          if (
            yield* fileSystem.stat(config).pipe(
              Effect.map((info) => info.type === "File"),
              Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
              Effect.orElseSucceed(() => true),
            )
          ) {
            const bare = yield* processRunner
              .run({
                command: "git",
                args: ["config", "--no-includes", "--file", config, "--bool", "--get", "core.bare"],
                env,
                timeoutBehavior: "timedOutResult",
              })
              .pipe(Effect.option);
            if (bare._tag === "None" || bare.value.timedOut || bare.value.stdout.trim() === "true")
              return true;
            if (
              bare.value.code !== 0 &&
              (yield* hasEntry(path.join(directory, "objects"))) &&
              (yield* hasEntry(path.join(directory, "refs")))
            )
              return true;
          }
          const parent = path.dirname(directory);
          if (parent === directory) return false;
          directory = parent;
        }
        return false;
      },
    );
    if (topLevelResult.value.code === 0) {
      // Git appends LF on every platform; a preceding CR belongs to the path.
      const [, climb, rootPath] =
        /^((?:\.\.\/)*)\n([\s\S]+)\n$/u.exec(topLevelResult.value.stdout) ?? [];
      if (
        climb === undefined ||
        !rootPath ||
        (yield* hasSkippedCheckout(climb.length / "../".length))
      )
        return undefined;
      return new RepositoryIdentityCacheKey({ rootPath, isBare: false });
    }
    // Explicit Git directories preserve safe.bareRepository=explicit for both layouts.
    for (const [gitDir, entry] of [
      [".", "HEAD"],
      [".git", ".git"],
    ] as const) {
      // An explicit --git-dir fails unless the folder has this entry; a symlink counts even
      // when its target is missing, as git reads a symlinked HEAD's target text.
      if (!(yield* hasEntry(path.join(cwd, entry)))) continue;
      const bareResult = yield* processRunner
        .run({
          command: "git",
          args: [
            "-C",
            cwd,
            `--git-dir=${gitDir}`,
            "rev-parse",
            "--is-bare-repository",
            "--absolute-git-dir",
          ],
          env,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      if (bareResult._tag === "None" || bareResult.value.timedOut) return undefined;
      if (bareResult.value.code !== 0) {
        if (entry === ".git" || (yield* hasEntry(path.join(cwd, "objects")))) return undefined;
        continue;
      }

      const [isBare, ...rootLines] = bareResult.value.stdout.split("\n");
      const rootPath = rootLines.join("\n").replace(/\n$/, "");
      // A checkout's .git directory contains remotes but is not a project root.
      return isBare === "true" && rootPath.length > 0
        ? new RepositoryIdentityCacheKey({ rootPath, isBare: true })
        : null;
    }
    if (!/^fatal: not a git repository \(or /mu.test(topLevelResult.value.stderr)) return undefined;
    return (yield* hasSkippedCheckout()) ? undefined : null;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (cacheKey: RepositoryIdentityCacheKey) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const env = gitEnv(yield* HostProcess.Platform);
  const runGit = (args: ReadonlyArray<string>) =>
    processRunner
      .run({
        command: "git",
        args: ["-C", cacheKey.rootPath, ...(cacheKey.isBare ? ["--git-dir=."] : []), ...args],
        env,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
  const [remoteResult, configResult] = yield* Effect.all(
    [
      runGit(["remote", "-v"]),
      runGit([
        "config",
        "--get-regexp",
        "^remote\\..*\\.(url|gh-resolved|t3-private-pr-companion)$",
      ]),
    ],
    { concurrency: "unbounded" },
  );
  if (
    remoteResult._tag === "None" ||
    remoteResult.value.code !== 0 ||
    remoteResult.value.timedOut ||
    remoteResult.value.stdoutTruncated ||
    remoteResult.value.stdoutInvalidUtf8
  ) {
    return undefined;
  }

  // Exits 1 when no key matches.
  const resolved =
    configResult._tag === "Some" && configResult.value.code === 0 ? configResult.value.stdout : "";
  const { remotes, fetchRemotes, hasLocalOrigin } = parseRemoteFetchUrls(
    remoteResult.value.stdout,
    parseConfiguredRemoteUrls(resolved),
  );
  const remote = pickPrimaryRemote(remotes, resolved);
  if (!remote) return null;
  const originUrl = remotes.get("origin");
  const keyUrl = yield* sshResolvedRemoteUrl(remote.remoteUrl, remotes);
  const originKeyUrl =
    originUrl === undefined || originUrl === remote.remoteUrl
      ? keyUrl
      : yield* sshResolvedRemoteUrl(originUrl, remotes);
  const identity = buildRepositoryIdentity({
    ...remote,
    keyUrl,
    originUrl,
    originKeyUrl,
    hasLocalOrigin,
    rootPath: cacheKey.rootPath,
  });
  if (hasLocalOrigin) return { identity, issueIdentity: null };
  for (const line of resolved.split("\n")) {
    const mark = /^remote\.(.+)\.t3-private-pr-companion\s+(.+)$/u.exec(line);
    if (!mark) continue;
    const [, name = "", companion = ""] = mark;
    const url = fetchRemotes.get(name);
    if (
      url &&
      sourceControlDefinitions.recognizeRemote(url)?.kind === "tanstack-source" &&
      sourceControlDefinitions.repositoryKeyFromRemote(companion) ===
        sourceControlDefinitions.repositoryKeyFromRemote(url)
    )
      fetchRemotes.delete(name);
  }
  const selected = selectRequirementRemote(
    Array.from(fetchRemotes, ([name, url]) => ({ name, url })),
  );
  if (!selected) return { identity, issueIdentity: null };
  if (selected.remoteUrl === remote.remoteUrl) return { identity };
  const issueIdentity = buildRepositoryIdentity({
    remoteName: selected.remoteName,
    remoteUrl: selected.remoteUrl,
    keyUrl:
      selected.remoteUrl === originUrl
        ? originKeyUrl
        : yield* sshResolvedRemoteUrl(selected.remoteUrl, remotes),
    originUrl: undefined,
    originKeyUrl: undefined,
    hasLocalOrigin: false,
    rootPath: cacheKey.rootPath,
  });
  return { identity, issueIdentity };
});

const unconfirmedProvider = Symbol("UnconfirmedProvider");

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === unconfirmedProvider
          ? Duration.zero
          : value == null
            ? DEFAULT_NEGATIVE_CACHE_TTL
            : DEFAULT_POSITIVE_CACHE_TTL,
      onFailure: () => Duration.zero,
    });

  const repositoryRootCache = yield* Cache.makeWith<
    string,
    RepositoryIdentityCacheKey | null | undefined
  >(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const remoteIdentityCache = yield* Cache.makeWith(
    (cacheKey: RepositoryIdentityCacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const providerIdentityCache = yield* Cache.makeWith<
    RepositoryIdentity,
    RepositoryIdentity | typeof unconfirmedProvider
  >(
    (identity) =>
      refine(identity).pipe(
        Effect.orElseSucceed((): typeof unconfirmedProvider => unconfirmedProvider),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
      if (cacheKey !== undefined) {
        if (cacheKey === null) return null;
        if (options?.refresh) yield* Cache.invalidate(remoteIdentityCache, cacheKey);
        const remote = yield* Cache.get(remoteIdentityCache, cacheKey);
        if (remote === null) return null;
        if (remote !== undefined) {
          const { identity, issueIdentity } = remote;
          if (options?.remoteOnly) return identity;
          if (options?.refresh) {
            yield* Cache.invalidate(providerIdentityCache, identity);
            if (issueIdentity) yield* Cache.invalidate(providerIdentityCache, issueIdentity);
          }
          const result = yield* Cache.get(providerIdentityCache, identity);
          const issue = issueIdentity && (yield* Cache.get(providerIdentityCache, issueIdentity));
          const grouping = result === unconfirmedProvider ? identity : result;
          const selected = issue === unconfirmedProvider ? issueIdentity : issue;
          const resolved =
            selected === undefined ? grouping : { ...grouping, issueRepository: selected };
          if (
            issue === unconfirmedProvider ||
            (issue === undefined && result === unconfirmedProvider)
          )
            return yield* options?.onUnavailable?.(resolved) ?? Effect.succeed(resolved);
          return resolved;
        }
      }
      return yield* options?.onUnavailable?.(null) ?? Effect.succeed(null);
    },
  );

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
