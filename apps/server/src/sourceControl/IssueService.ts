import {
  IssueError,
  IssueSource,
  SourceControlProviderError,
  SourceControlProviderKind,
  type IssueTarget,
  type IssueListInput,
  type IssueListResult,
  type IssueCreateInput,
  type IssueMetadataInput,
  type IssuePeopleInput,
  type IssueReadInput,
  type IssueSetStateInput,
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
import * as Settings from "../serverSettings.ts";
import * as Providers from "./SourceControlProviderRegistry.ts";
import * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

type Board = NonNullable<Provider.SourceControlProvider["Service"]["issueBoard"]>;
class DiscoveryKey extends Persistable.Class<{
  payload: { readonly cwd: string; readonly remoteUrl: string; readonly key: string };
}>()("IssueSourceDiscovery", {
  primaryKey: ({ key }) => key,
  success: Schema.Array(IssueSource),
  error: SourceControlProviderError,
}) {
  [Equal.symbol](other: unknown): boolean {
    return (
      other instanceof DiscoveryKey &&
      normalizeGitRemoteUrl(this.remoteUrl) === normalizeGitRemoteUrl(other.remoteUrl)
    );
  }
  [Hash.symbol](): number {
    return Hash.string(normalizeGitRemoteUrl(this.remoteUrl));
  }
}
export class IssueService extends Context.Service<
  IssueService,
  {
    readonly sources: (
      input: typeof IssueSourcesInput.Type,
    ) => Effect.Effect<typeof IssueSourcesResult.Type, IssueError>;
    readonly list: (
      input: IssueListInput,
    ) => Effect.Effect<typeof IssueListResult.Type, IssueError>;
    readonly read: (input: typeof IssueReadInput.Type) => ReturnType<Board["read"]>;
    readonly people: (input: typeof IssuePeopleInput.Type) => ReturnType<Board["people"]>;
    readonly metadata: (input: typeof IssueMetadataInput.Type) => ReturnType<Board["metadata"]>;
    readonly create: (input: typeof IssueCreateInput.Type) => ReturnType<Board["create"]>;
    readonly setState: (input: typeof IssueSetStateInput.Type) => ReturnType<Board["setState"]>;
  }
>()("t3/sourceControl/IssueService") {}

export const make = Effect.gen(function* () {
  const projects = yield* Projects.ProjectService;
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* Providers.SourceControlProviderRegistry;
  const digester = yield* Digest.Digest;
  const discovery = yield* PersistedCache.make(
    Effect.fn("IssueService.discover")(function* (key: DiscoveryKey) {
      const handle = yield* providers.resolveHandle({ cwd: key.cwd });
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
  const projectSources = Effect.fn("IssueService.projectSources")(function* (
    projectId: IssueTarget["projectId"],
    refresh = false,
  ) {
    const project = yield* projects
      .getShell(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new IssueError({ operation: "project", reason: "invalid-target", cause }),
        ),
      );
    if (Option.isNone(project))
      return yield* new IssueError({ operation: "project", reason: "invalid-target" });
    const cwd = project.value.workspaceRoot;
    const saved = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new IssueError({ operation: "settings", reason: "unavailable", cause }),
      ),
    );
    const manual = saved.issueProjectSources[projectId] ?? [];
    const automatic: IssueSource[] = [];
    const handle = yield* providers.resolveHandle({ cwd }).pipe(Effect.result);
    let repository: string | null = null;
    let error: string | undefined;
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
      if (provider.discoverIssueSources) {
        const digest = yield* digester.digest(
          Digest.sha256,
          new TextEncoder().encode(normalizeGitRemoteUrl(context.remoteUrl)),
        );
        const key = new DiscoveryKey({
          cwd,
          remoteUrl: context.remoteUrl,
          key: Hex.encode(digest),
        });
        const result = yield* (
          refresh
            ? discovery.invalidate(key).pipe(Effect.andThen(discovery.get(key)))
            : discovery.get(key)
        ).pipe(Effect.result);
        if (result._tag === "Success") automatic.push(...result.success);
        else error = new IssueError({ operation: "discovery", reason: "unavailable" }).message;
      }
    } else if (handle._tag === "Failure")
      error = new IssueError({ operation: "repository", reason: "unavailable" }).message;
    const overridden = new Set(manual.map((source) => source.provider));
    return {
      cwd,
      projectId,
      repository,
      sources: [...automatic.filter((source) => !overridden.has(source.provider)), ...manual],
      manual: manual.length > 0,
      ...(error ? { error } : {}),
    };
  });
  const resolveAll = Effect.fn("IssueService.resolveAll")(function* (input: IssueTarget) {
    const resolved = yield* projectSources(input.projectId);
    const sources = resolved.sources.filter(
      (source) =>
        source.provider === input.provider && (!input.scope || source.scope === input.scope),
    );
    for (const source of sources) {
      if (
        source.provider === "meituan"
          ? !/^[1-9]\d*$/u.test(source.scope) || source.host !== "mep.sankuai.com"
          : !/^[\w.-]+\/[\w.-]+$/u.test(source.scope) || !/^[\w.-]+$/u.test(source.host)
      )
        return yield* new IssueError({ operation: "resolve", reason: "invalid-target" });
    }
    if (!sources.length)
      return yield* new IssueError({
        operation: "resolve",
        reason: resolved.error ? "unavailable" : "invalid-target",
      });
    const provider = yield* providers
      .get(SourceControlProviderKind.make(input.provider))
      .pipe(
        Effect.mapError(
          (cause) => new IssueError({ operation: "provider", reason: "unsupported", cause }),
        ),
      );
    if (!provider.issueBoard)
      return yield* new IssueError({ operation: "provider", reason: "unsupported" });
    return sources.map((source) => ({ cwd: resolved.cwd, source, board: provider.issueBoard! }));
  });
  const resolve = Effect.fn("IssueService.resolve")(function* (input: IssueTarget) {
    const targets = yield* resolveAll(input);
    if (targets.length !== 1)
      return yield* new IssueError({ operation: "resolve", reason: "invalid-target" });
    return targets[0]!;
  });
  return IssueService.of({
    sources: Effect.fn("IssueService.sources")(function* (input) {
      return yield* Effect.forEach(
        [...new Set(input.projectIds)],
        (projectId) =>
          projectSources(projectId, input.refresh).pipe(
            Effect.map(({ cwd: _cwd, ...result }) => result),
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
      const all = yield* projects
        .listShells(input.projectId ? { projectIds: [input.projectId] } : undefined)
        .pipe(
          Effect.mapError(
            (cause) => new IssueError({ operation: "projects", reason: "unavailable", cause }),
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
      const failures: Array<(typeof IssueListResult.Type)["failures"][number]> = [];
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
      const target = yield* resolve(input);
      return yield* target.board.create({ ...input, ...target });
    }),
    setState: Effect.fn("IssueService.setState")(function* (input) {
      const target = yield* resolve(input);
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
