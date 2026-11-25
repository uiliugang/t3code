import {
  RequirementIssueError,
  isMeituanServiceEnabled,
  mergeProjectIssueSources,
  projectIssueProvider,
  IssueSource,
  SourceControlProviderError,
  SourceControlProviderKind,
  VcsUnsupportedOperationError,
  type IssueTarget,
  type OrchestrationProjectShell,
  type ServerSettings,
  type RequirementIssueListInput,
  type RequirementIssueListResult,
  type RequirementIssueCreateInput,
  type IssueMetadataInput,
  type IssuePeopleInput,
  type IssueReadInput,
  type RequirementIssueSetStateInput,
  type IssueSourcesInput,
  type IssueSourcesResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Persistable from "effect/persistence/Persistable";
import * as PersistedCache from "effect/persistence/PersistedCache";
import * as Persistence from "effect/persistence/Persistence";
import * as ServerConfig from "../config.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "./SourceControlProviderRegistry.ts";
import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";
import * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";

type Board = NonNullable<Provider.SourceControlProvider["Service"]["issueBoard"]>;
const isUnsupportedVcsOperation = Schema.is(VcsUnsupportedOperationError);
class DiscoveryKey extends Persistable.Class<{
  payload: {
    readonly cwd: string;
    readonly context: Provider.SourceControlProviderContext;
    readonly key: string;
  };
}>()("IssueSourceDiscovery", {
  primaryKey: ({ key }) => key,
  success: Schema.Array(IssueSource),
  error: SourceControlProviderError,
}) {
  [Equal.symbol](other: unknown): boolean {
    return other instanceof DiscoveryKey && this.key === other.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}
export class IssueService extends Context.Service<
  IssueService,
  {
    readonly trackerSources: Effect.Effect<
      {
        readonly scratchRoot: Option.Option<string>;
        readonly forProject: (project: OrchestrationProjectShell) => Effect.Effect<{
          readonly sources: ReadonlyArray<IssueSource>;
          readonly failure?: RequirementIssueError;
        }>;
      },
      RequirementIssueError
    >;
    readonly sources: (
      input: typeof IssueSourcesInput.Type,
    ) => Effect.Effect<typeof IssueSourcesResult.Type, RequirementIssueError>;
    readonly list: (
      input: RequirementIssueListInput,
    ) => Effect.Effect<typeof RequirementIssueListResult.Type, RequirementIssueError>;
    readonly read: (input: typeof IssueReadInput.Type) => ReturnType<Board["read"]>;
    readonly people: (input: typeof IssuePeopleInput.Type) => ReturnType<Board["people"]>;
    readonly metadata: (input: typeof IssueMetadataInput.Type) => ReturnType<Board["metadata"]>;
    readonly create: (
      input: typeof RequirementIssueCreateInput.Type,
    ) => ReturnType<Board["create"]>;
    readonly setState: (
      input: typeof RequirementIssueSetStateInput.Type,
    ) => ReturnType<Board["setState"]>;
  }
>()("t3/sourceControl/IssueService") {}

export const make = Effect.gen(function* () {
  const projects = yield* Projects.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* Providers.SourceControlProviderRegistry;
  const digester = yield* Digest.Digest;
  const discovery = yield* PersistedCache.make(
    Effect.fn("IssueService.discover")(function* (key: DiscoveryKey) {
      const handle = yield* providers.resolveHandle({ cwd: key.cwd, context: key.context });
      return handle.context && handle.provider.discoverIssueSources
        ? yield* handle.provider.discoverIssueSources({ cwd: key.cwd, context: handle.context })
        : [];
    }),
    {
      storeId: "issue-sources-v1",
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.seconds(30)),
      inMemoryTTL: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.seconds(30)),
      inMemoryCapacity: 256,
    },
  ).pipe(Effect.provide(Persistence.layerKvs));
  const savedSettings = settings.getSettings.pipe(
    Effect.mapError(
      (cause) => new RequirementIssueError({ operation: "settings", reason: "unavailable", cause }),
    ),
  );
  const resolveSources = Effect.fn("IssueService.resolveSources")(function* (
    project: OrchestrationProjectShell,
    saved: ServerSettings,
    refresh = false,
    refreshRepository = refresh,
  ) {
    const { id: projectId, workspaceRoot: cwd } = project;
    const manual = saved.issueProjectSources[projectId] ?? [];
    const automatic: IssueSource[] = [];
    const identity = project.repositoryIdentity;
    const originUrl = identity?.origin?.remoteUrl;
    const lookup = (
      remote?: { readonly remoteName: string; readonly remoteUrl: string },
      canonicalKey?: string,
    ) => {
      const host =
        remote &&
        sourceControlDefinitions.recognizeRemote(
          canonicalKey && isSshRemoteUrl(remote.remoteUrl)
            ? `https://${canonicalKey}`
            : remote.remoteUrl,
        );
      return providers
        .resolveHandle({
          cwd,
          refresh: refreshRepository,
          ...(remote && host
            ? {
                context: {
                  provider: host,
                  remoteName: remote.remoteName,
                  remoteUrl: remote.remoteUrl,
                },
              }
            : {}),
        })
        .pipe(Effect.result);
    };
    const origin = originUrl
      ? yield* lookup(
          { remoteName: "origin", remoteUrl: originUrl },
          identity?.origin?.canonicalKey,
        )
      : undefined;
    const handle =
      origin && (origin._tag === "Failure" || origin.success.provider.kind === identity?.provider)
        ? origin
        : yield* lookup(identity?.locator, identity?.canonicalKey);
    let repository: string | null = null;
    let failure: RequirementIssueError | undefined;
    if (handle._tag === "Success" && handle.success.context) {
      const { provider, context } = handle.success;
      repository =
        provider.repositoryNameFromRemoteUrl?.(context.remoteUrl) ??
        Provider.repositoryPathFromRemoteUrl(context.remoteUrl);
      if (provider.kind === "github" && repository)
        automatic.push({
          provider: "github",
          scope: repository,
          host: new URL(context.provider.baseUrl).hostname,
        });
      if (
        provider.discoverIssueSources &&
        (provider.kind !== "meituan" || isMeituanServiceEnabled(saved, "requirements"))
      ) {
        const digest = yield* digester.digest(
          Digest.sha256,
          new TextEncoder().encode(normalizeGitRemoteUrl(context.remoteUrl)),
        );
        const key = new DiscoveryKey({
          cwd,
          context,
          key: Hex.encode(digest),
        });
        const result = yield* (
          refresh
            ? discovery.invalidate(key).pipe(Effect.andThen(discovery.get(key)))
            : discovery.get(key)
        ).pipe(Effect.result);
        if (result._tag === "Success") automatic.push(...result.success);
        else
          failure = new RequirementIssueError({
            operation: "discovery",
            reason: "unavailable",
            cause: result.failure,
          });
      }
    } else if (
      handle._tag === "Failure" &&
      !(
        isUnsupportedVcsOperation(handle.failure.cause) &&
        handle.failure.cause.operation === "VcsDriverRegistry.resolve" &&
        handle.failure.cause.kind === "unknown"
      )
    )
      failure = new RequirementIssueError({
        operation: "repository",
        reason: "unavailable",
        cause: handle.failure,
      });
    const repositoryKind =
      projectIssueProvider(project.repositoryIdentity?.provider, []) ??
      (handle._tag === "Success" && handle.success.context
        ? handle.success.provider.kind
        : undefined);
    const sources = mergeProjectIssueSources(automatic, manual, repositoryKind).filter(
      (source) => source.provider !== "meituan" || isMeituanServiceEnabled(saved, "requirements"),
    );
    const provider = projectIssueProvider(repositoryKind, automatic.length ? automatic : manual);
    return {
      cwd,
      projectId,
      repository,
      ...(provider ? { provider } : {}),
      sources,
      manual: sources.length > 0 && manual.some((source) => source.provider === provider),
      ...(failure ? { failure } : {}),
    };
  });
  const projectSources = Effect.fn("IssueService.projectSources")(function* (
    id: IssueTarget["projectId"],
    refresh = false,
    refreshRepository = refresh,
  ) {
    const project = yield* projects
      .getShell(id, undefined, refreshRepository ? "refresh" : "resolve")
      .pipe(
        Effect.mapError(
          (cause) =>
            new RequirementIssueError({ operation: "project", reason: "invalid-target", cause }),
        ),
      );
    if (Option.isNone(project))
      return yield* new RequirementIssueError({ operation: "project", reason: "invalid-target" });
    return yield* resolveSources(project.value, yield* savedSettings, refresh, refreshRepository);
  });
  const validSource = (source: IssueSource) =>
    source.provider === "meituan"
      ? /^[1-9]\d*$/u.test(source.scope) && source.host === "mep.sankuai.com"
      : /^[\w.-]+\/[\w.-]+$/u.test(source.scope) && /^[\w.-]+$/u.test(source.host);
  const resolveAll = Effect.fn("IssueService.resolveAll")(function* (
    input: IssueTarget,
    refreshRepository = false,
  ) {
    const resolved = yield* projectSources(input.projectId, false, refreshRepository);
    const sources = resolved.sources.filter(
      (source) =>
        source.provider === input.provider &&
        (!input.scope || source.scope === input.scope) &&
        (!input.host || source.host === input.host),
    );
    for (const source of sources) {
      if (!validSource(source))
        return yield* new RequirementIssueError({ operation: "resolve", reason: "invalid-target" });
    }
    if (!sources.length)
      return yield* (
        resolved.failure ??
          new RequirementIssueError({ operation: "resolve", reason: "invalid-target" })
      );
    const provider = yield* providers
      .get(SourceControlProviderKind.make(input.provider))
      .pipe(
        Effect.mapError(
          (cause) =>
            new RequirementIssueError({ operation: "provider", reason: "unsupported", cause }),
        ),
      );
    if (!provider.issueBoard)
      return yield* new RequirementIssueError({ operation: "provider", reason: "unsupported" });
    return sources.map((source) => ({ cwd: resolved.cwd, source, board: provider.issueBoard! }));
  });
  const resolve = Effect.fn("IssueService.resolve")(function* (
    input: IssueTarget,
    refreshRepository = false,
  ) {
    const targets = yield* resolveAll(input, refreshRepository);
    if (targets.length !== 1)
      return yield* new RequirementIssueError({ operation: "resolve", reason: "invalid-target" });
    return targets[0]!;
  });
  return IssueService.of({
    trackerSources: Effect.gen(function* () {
      const saved = yield* savedSettings;
      const scratchRoot = yield* managedFolders.scratchRoot;
      return {
        scratchRoot,
        forProject: Effect.fn("IssueService.trackerSources")(function* (
          project: OrchestrationProjectShell,
        ) {
          const enabled = isMeituanServiceEnabled(saved, "requirements");
          const manual = mergeProjectIssueSources(
            [],
            saved.issueProjectSources[project.id] ?? [],
            project.repositoryIdentity?.provider,
          ).filter((source) => source.provider !== "meituan" || enabled);
          const discover =
            enabled &&
            project.repositoryIdentity?.provider === "meituan" &&
            !manual.some((source) => source.provider === "meituan");
          const resolved = discover ? yield* resolveSources(project, saved) : { sources: manual };
          const sources = resolved.sources.filter(validSource);
          return {
            ...resolved,
            sources,
            ...(sources.length !== resolved.sources.length
              ? {
                  failure: new RequirementIssueError({
                    operation: "resolve",
                    reason: "invalid-target",
                  }),
                }
              : {}),
          };
        }),
      };
    }),
    sources: Effect.fn("IssueService.sources")(function* (input) {
      return yield* Effect.forEach(
        [...new Set(input.projectIds)],
        (projectId) =>
          projectSources(projectId, input.refresh).pipe(
            Effect.map(({ cwd: _cwd, failure, ...result }) => ({
              ...result,
              ...(failure ? { error: failure.message } : {}),
            })),
            Effect.catch((error) =>
              Effect.succeed({
                projectId,
                repository: null,
                sources: [],
                manual: false,
                error: error.message,
              }),
            ),
          ),
        { concurrency: 4 },
      );
    }),
    list: Effect.fn("IssueService.list")(function* (input) {
      if (
        input.provider === "meituan" &&
        !isMeituanServiceEnabled(
          yield* settings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new RequirementIssueError({ operation: "list", reason: "unavailable", cause }),
            ),
          ),
          "requirements",
        )
      )
        return { groups: [], failures: [] };
      const scratchRoot = yield* managedFolders.scratchRoot;
      const all = yield* projects
        .listShells(input.projectId ? { projectIds: [input.projectId] } : undefined)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RequirementIssueError({ operation: "projects", reason: "unavailable", cause }),
          ),
          Effect.map((projects) =>
            projects.filter(
              (project) =>
                !project.archivedAt &&
                !(Option.isSome(scratchRoot) && project.workspaceRoot === scratchRoot.value),
            ),
          ),
        );
      const targets = yield* Effect.forEach(
        all,
        (project) =>
          resolveAll({ projectId: project.id, provider: input.provider }).pipe(
            Effect.map((targets) => ({ projectId: project.id, targets })),
            Effect.result,
          ),
        { concurrency: 4 },
      );
      const distinct = new Map<
        string,
        {
          target: { cwd: string; source: IssueSource; board: Board };
          projectIds: Array<(typeof all)[number]["id"]>;
        }
      >();
      const failures: Array<(typeof RequirementIssueListResult.Type)["failures"][number]> = [];
      for (let index = 0; index < targets.length; index++) {
        const entry = targets[index]!;
        if (entry._tag === "Failure") {
          if (entry.failure.reason !== "invalid-target" || input.projectId)
            failures.push({ projectId: all[index]!.id, reason: entry.failure.message });
          continue;
        }
        const { projectId, targets: resolvedTargets } = entry.success;
        for (const target of resolvedTargets) {
          const key = `${target.source.provider}\n${target.source.host}\n${target.source.scope}`;
          const existing = distinct.get(key);
          if (existing) {
            if (!existing.projectIds.includes(projectId)) existing.projectIds.push(projectId);
          } else distinct.set(key, { target, projectIds: [projectId] });
        }
      }
      const groups = yield* Effect.forEach(
        [...distinct.values()],
        ({ target, projectIds }) =>
          target.board.search({ ...input, ...target }).pipe(
            Effect.map((result) => ({ ...result, source: target.source, projectIds })),
            Effect.catch((error) => {
              failures.push({ projectId: projectIds[0]!, reason: error.message });
              return Effect.succeed(null);
            }),
          ),
        { concurrency: 2 },
      );
      return { groups: groups.filter((entry) => entry !== null), failures };
    }),
    read: Effect.fn("IssueService.read")(function* (input) {
      const target = yield* resolve(input);
      return yield* target.board.read({ ...input, ...target });
    }),
    people: Effect.fn("IssueService.people")(function* (input) {
      const target = yield* resolve(input);
      return yield* target.board.people({ ...input, ...target });
    }),
    metadata: Effect.fn("IssueService.metadata")(function* (input) {
      const target = yield* resolve(input);
      return yield* target.board.metadata({ ...input, ...target });
    }),
    create: Effect.fn("IssueService.create")(function* (input) {
      const target = yield* resolve(input, true);
      return yield* target.board.create({ ...input, ...target });
    }),
    setState: Effect.fn("IssueService.setState")(function* (input) {
      const target = yield* resolve(input, true);
      return yield* target.board.setState({ ...input, ...target });
    }),
  });
});
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(IssueService, make).pipe(
      Layer.provide(
        KeyValueStore.layerFileSystem(path.join(config.providerStatusCacheDir, "issue-sources")),
      ),
    );
  }),
);
