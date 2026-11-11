import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  IssueError,
  ProjectId,
  SourceControlProviderKind,
  SourceControlProviderError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "./SourceControlProviderRegistry.ts";
import * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Service from "./IssueService.ts";

describe("IssueService", () => {
  it.effect(
    "retries failed discoveries while persisting empty results across service restarts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issue-sources-" });
        const projectId = ProjectId.make("project");
        let discoveries = 0;
        const provider = yield* Provider.SourceControlProvider.pipe(
          Effect.provide(
            Layer.mock(Provider.SourceControlProvider)({
              kind: SourceControlProviderKind.make("meituan"),
              repositoryNameFromRemoteUrl: Provider.repositoryPathFromRemoteUrl,
              discoverIssueSources: () => {
                discoveries++;
                return discoveries === 1
                  ? Effect.fail(
                      new SourceControlProviderError({
                        provider: SourceControlProviderKind.make("meituan"),
                        cwd: "/project",
                        operation: "discoverIssueSources",
                        detail: "Temporarily offline",
                      }),
                    )
                  : Effect.succeed(
                      discoveries === 2
                        ? []
                        : [
                            {
                              provider: "meituan" as const,
                              host: "mep.sankuai.com",
                              scope: "6259",
                            },
                          ],
                    );
              },
            }),
          ),
        );
        const create = Service.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              KeyValueStore.layerFileSystem(directory),
              Settings.ServerSettingsService.layerTest(),
              Layer.mock(Projects.ProjectService)({
                getShell: () =>
                  Effect.succeedSome({
                    id: projectId,
                    title: "project",
                    workspaceRoot: "/project",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:00:00Z",
                  }),
              }),
              Layer.mock(Providers.SourceControlProviderRegistry)({
                resolveLink: () => undefined,
                resolveHandle: () =>
                  Effect.succeed({
                    provider,
                    context: {
                      provider: {
                        kind: provider.kind,
                        name: "Meituan",
                        baseUrl: "https://git.sankuai.com",
                      },
                      remoteName: "origin",
                      remoteUrl: "https://git.sankuai.com/team/project.git",
                    },
                  }),
              }),
            ),
          ),
        );
        const input = { projectIds: [projectId] };
        const first = yield* create;
        expect((yield* first.sources(input))[0]?.error).toBeDefined();
        expect((yield* (yield* create).sources(input))[0]?.error).toBeDefined();
        expect(discoveries).toBe(1);
        yield* TestClock.adjust("31 seconds");
        expect((yield* first.sources(input))[0]?.error).toBeUndefined();
        expect((yield* (yield* create).sources(input))[0]?.sources).toEqual([]);
        yield* TestClock.adjust("365 days");
        const restarted = yield* create;
        expect((yield* restarted.sources(input))[0]?.sources).toEqual([]);
        expect(discoveries).toBe(2);
        const refreshed = yield* restarted.sources({ ...input, refresh: true });
        expect(refreshed[0]?.sources).toEqual([
          { provider: "meituan", host: "mep.sankuai.com", scope: "6259" },
        ]);
        expect(yield* (yield* create).sources(input)).toEqual(refreshed);
        expect(discoveries).toBe(3);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "deduplicates shared sources, isolates failures and resolves targets from fresh settings",
    () =>
      Effect.gen(function* () {
        const projects = ["first", "shared", "offline", "invalid"].map((name) => ({
          id: ProjectId.make(name),
          title: name,
          workspaceRoot: `/${name}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }));
        const sources = Object.fromEntries(
          projects.map((project, index) => [
            project.id,
            [
              {
                provider: "meituan" as const,
                host: "mep.sankuai.com",
                scope: index < 2 ? "1031008" : index === 2 ? "123" : "invalid",
              },
            ],
          ]),
        );
        const searched: string[] = [];
        let discovered = false;
        let discoveries = 0;
        sources[projects[0]!.id]!.push({
          provider: "meituan",
          host: "mep.sankuai.com",
          scope: "456",
        });
        const provider = yield* Provider.SourceControlProvider.pipe(
          Effect.provide(
            Layer.mock(Provider.SourceControlProvider)({
              kind: SourceControlProviderKind.make("meituan"),
              discoverIssueSources: () => {
                discoveries++;
                return Effect.succeed(
                  discovered
                    ? [{ provider: "meituan", host: "mep.sankuai.com", scope: "789" }]
                    : [],
                );
              },
              issueBoard: {
                read: ({ source }) =>
                  Effect.succeed({
                    id: "1",
                    url: "https://mep.sankuai.com/",
                    title: source.scope,
                    state: "",
                    stateCategory: "todo",
                    type: "",
                    assignees: [],
                    priority: "",
                    updatedAt: "",
                    body: "",
                    bodyFormat: "markdown",
                    transitions: [],
                  }),
                people: () => Effect.die("unexpected people"),
                metadata: () => Effect.die("unexpected metadata"),
                create: () => Effect.die("unexpected create"),
                setState: () => Effect.die("unexpected state change"),
                search: ({ source }) => {
                  searched.push(source.scope);
                  return source.scope === "123"
                    ? Effect.fail(new IssueError({ operation: "search", reason: "unavailable" }))
                    : Effect.succeed({ issues: [], hasMore: false });
                },
              },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* Service.IssueService;
          const result = yield* service.list({
            provider: "meituan",
            assignee: "all",
            query: "",
            page: 1,
          });
          expect(searched.toSorted()).toEqual(["1031008", "123", "456"]);
          expect(discoveries).toBe(1);
          expect(result.groups.map((group) => group.projectIds)).toEqual([
            [projects[0]!.id, projects[1]!.id],
            [projects[0]!.id],
          ]);
          expect(
            (yield* service.read({
              provider: "meituan",
              projectId: projects[0]!.id,
              scope: "456",
              id: "1",
            })).title,
          ).toBe("456");
          expect(
            (yield* service
              .read({ provider: "meituan", projectId: projects[0]!.id, id: "1" })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid-target");
          expect(result.failures.map((failure) => failure.projectId)).toEqual([projects[2]!.id]);
          expect(
            (yield* service
              .read({ provider: "meituan", projectId: ProjectId.make("missing"), id: "1" })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid-target");
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({ issueProjectSources: { [projects[0]!.id]: [] } });
          expect(
            (yield* service
              .read({ provider: "meituan", projectId: projects[0]!.id, id: "1" })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid-target");
          discovered = true;
          const before = discoveries;
          yield* TestClock.adjust("1 hour");
          yield* service.sources({ projectIds: [projects[0]!.id] });
          expect(discoveries).toBe(before);
          expect(
            (yield* service.sources({ projectIds: [projects[0]!.id], refresh: true }))[0]?.sources,
          ).toEqual([{ provider: "meituan", host: "mep.sankuai.com", scope: "789" }]);
          expect(
            (yield* service.read({
              provider: "meituan",
              projectId: projects[0]!.id,
              scope: "789",
              id: "1",
            })).title,
          ).toBe("789");
        }).pipe(
          Effect.provide(
            Layer.effect(Service.IssueService, Service.make).pipe(
              Layer.provide(Layer.mergeAll(KeyValueStore.layerMemory, NodeCrypto.layer)),
              Layer.provide(
                Layer.mock(Projects.ProjectService)({
                  getShell: (id) =>
                    Effect.succeed(
                      Option.fromUndefinedOr(projects.find((project) => project.id === id)),
                    ),
                  listShells: (options) =>
                    Effect.succeed(
                      projects.filter(
                        (project) =>
                          !options?.projectIds || options.projectIds.includes(project.id),
                      ),
                    ),
                }),
              ),
              Layer.provide(
                Layer.mock(Providers.SourceControlProviderRegistry)({
                  resolveLink: () => undefined,
                  get: () => Effect.succeed(provider),
                  resolveHandle: () =>
                    Effect.succeed({
                      provider,
                      context: {
                        provider: {
                          kind: provider.kind,
                          name: "Meituan",
                          baseUrl: "https://git.sankuai.com",
                        },
                        remoteName: "origin",
                        remoteUrl: "https://git.sankuai.com/team/shared.git",
                      },
                    }),
                }),
              ),
              Layer.provideMerge(
                Settings.ServerSettingsService.layerTest({ issueProjectSources: sources }),
              ),
            ),
          ),
        );
      }),
  );
});
