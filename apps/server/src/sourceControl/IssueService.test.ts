import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  RequirementIssueError,
  type IssueSource,
  ProjectId,
  SourceControlProviderKind,
  SourceControlProviderError,
  VcsDriverKind,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Projects from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "./SourceControlProviderRegistry.ts";
import * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";
import { fakeSourceControlProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as Service from "./IssueService.ts";

describe("IssueService", () => {
  it.effect.each([
    ["github.com", "https://github.com/me/fork.git"],
    ["forge.example.test", "https://forge.example.test/me/fork.git"],
    ["github.com", "git@work:me/fork.git"],
  ] as const)(
    "creates a %s fork issue in the repository offered for %s on the first lookup",
    ([host, remoteUrl]) =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("fork");
        const origin = { remoteName: "origin", remoteUrl };
        const provider = fakeSourceControlProvider("github", {
          issueBoard: {
            search: () => Effect.die("unexpected search"),
            read: () => Effect.die("unexpected read"),
            people: () => Effect.die("unexpected people"),
            metadata: () => Effect.die("unexpected metadata"),
            setState: () => Effect.die("unexpected state change"),
            create: ({ source, title }) =>
              Effect.succeed({
                id: "1",
                url: `https://${source.host}/${source.scope}/issues/1`,
                title,
                state: "open",
                stateCategory: "todo",
                type: "",
                assignees: [],
                priority: "",
                updatedAt: "",
              }),
          },
        });
        const github = { kind: provider.kind, name: "GitHub", baseUrl: `https://${host}` };
        const service = yield* Service.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              KeyValueStore.layerMemory,
              NodeCrypto.layer,
              Settings.ServerSettingsService.layerTest({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/projects",
              }),
              Layer.mock(Projects.ProjectService)({
                getShell: (_id, _cwd, lookup) =>
                  Effect.succeedSome({
                    id: projectId,
                    title: "fork",
                    workspaceRoot: "/fork",
                    scripts: [],
                    defaultModelSelection: null,
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:00:00Z",
                    repositoryIdentity: lookup
                      ? {
                          provider: provider.kind,
                          canonicalKey: `${host}/org/repo`,
                          locator: {
                            source: "git-remote",
                            remoteName: "upstream",
                            remoteUrl: `https://${host}/org/repo.git`,
                          },
                          origin: { canonicalKey: `${host}/me/fork`, remoteUrl: origin.remoteUrl },
                        }
                      : null,
                  }),
              }),
              Layer.mock(Providers.SourceControlProviderRegistry)({
                resolveLink: () => undefined,
                get: () => Effect.succeed(provider),
                resolveHandle: ({ context }) => {
                  const anonymous = context?.provider.baseUrl === "https://work";
                  return Effect.succeed({
                    provider: anonymous ? fakeSourceControlProvider("unknown", {}) : provider,
                    context: {
                      ...(context ?? origin),
                      provider: anonymous ? context.provider : github,
                    },
                  });
                },
              }),
            ),
          ),
        );
        const [listed] = yield* service.sources({ projectIds: [projectId] });
        const source = listed!.sources[0]!;
        expect(source.scope).toBe("me/fork");
        expect(
          (yield* service.sources({ projectIds: [projectId], refresh: true }))[0]?.sources,
        ).toEqual([source]);
        const created = yield* service.create({
          ...source,
          projectId,
          title: "Fork issue",
          type: "DEVTASK",
          subtype: "",
          body: "",
          assignees: [],
          fields: {},
        });
        expect(created.url).toBe(`https://${host}/me/fork/issues/1`);
      }),
  );

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
              Settings.ServerSettingsService.layerTest({ meituanIntegrationEnabled: true }),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/projects",
                scratchRoot: Effect.succeedNone,
              }),
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
        expect((yield* first.sources(input))[0]?.error).toBe(
          "Could not discover issue sources for this repository. Check its issue associations or configure a source in Requirements settings.",
        );
        expect(
          yield* first.read({ provider: "meituan", projectId, id: "1" }).pipe(Effect.flip),
        ).toMatchObject({ operation: "discovery", reason: "unavailable" });
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
        const projects = [
          "first",
          "shared",
          "offline",
          "invalid",
          "scratch",
          "archived",
          "not-a-repository",
          "discovery-offline",
          "manual-offline",
          "local-folder",
        ].map((name) => ({
          id: ProjectId.make(name),
          title: name,
          workspaceRoot: `/${name}`,
          defaultModelSelection: null,
          scripts: [],
          archivedAt: name === "archived" ? "2026-01-01T00:00:00Z" : null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }));
        const sources: Record<string, IssueSource[]> = Object.fromEntries(
          projects.slice(0, 4).map((project, index) => [
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
        sources[projects[8]!.id] = [{ provider: "meituan", host: "mep.sankuai.com", scope: "999" }];
        const searched: string[] = [];
        const resolved: string[] = [];
        let discovered = false;
        let movedToGithub = false;
        let discoveries = 0;
        sources[projects[0]!.id]!.push({
          provider: "meituan",
          host: "mep.sankuai.com",
          scope: "456",
        });
        sources[projects[0]!.id]!.unshift({
          provider: "github",
          host: "github.com",
          scope: "acme/legacy",
        });
        const provider = yield* Provider.SourceControlProvider.pipe(
          Effect.provide(
            Layer.mock(Provider.SourceControlProvider)({
              kind: SourceControlProviderKind.make("meituan"),
              discoverIssueSources: ({ cwd }) => {
                if (cwd === "/discovery-offline")
                  return Effect.fail(
                    new SourceControlProviderError({
                      provider: SourceControlProviderKind.make("meituan"),
                      cwd,
                      operation: "discoverIssueSources",
                      detail: "Temporarily offline",
                    }),
                  );
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
                    ? Effect.fail(
                        new RequirementIssueError({ operation: "search", reason: "unavailable" }),
                      )
                    : Effect.succeed({ issues: [], hasMore: false });
                },
              },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* Service.IssueService;
          const repoProject = {
            ...projects[0]!,
            repositoryIdentity: {
              provider: SourceControlProviderKind.make("meituan"),
              canonicalKey: "git.sankuai.com/team/shared",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "https://git.sankuai.com/team/shared.git",
              },
            },
          };
          expect(
            (yield* service.sources({ projectIds: [ProjectId.make("local-folder")] }))[0],
          ).toEqual({
            projectId: ProjectId.make("local-folder"),
            repository: null,
            sources: [],
            manual: false,
          });
          const expectedSpaces = sources[repoProject.id]!.filter(
            (source) => source.provider === "meituan",
          );
          expect((yield* (yield* service.trackerSources).forProject(repoProject)).sources).toEqual(
            expectedSpaces,
          );
          expect((yield* service.sources({ projectIds: [repoProject.id] }))[0]?.sources).toEqual(
            expectedSpaces,
          );
          expect(
            (yield* service
              .read({ provider: "github", projectId: repoProject.id, id: "1" })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid-target");
          const result = yield* service.list({
            provider: "meituan",
            assignee: "all",
            query: "",
            page: 1,
          });
          expect(resolved).not.toContain("/scratch");
          expect(resolved).not.toContain("/archived");
          expect(searched.toSorted()).toEqual(["1031008", "123", "456", "999"]);
          expect(discoveries).toBe(1);
          expect(result.groups.map((group) => group.projectIds)).toEqual([
            [projects[0]!.id, projects[1]!.id],
            [projects[0]!.id],
            [projects[8]!.id],
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
              .read({
                provider: "meituan",
                projectId: projects[0]!.id,
                scope: "456",
                host: "changed.example",
                id: "1",
              })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid-target");
          expect(
            (yield* service
              .read({ provider: "meituan", projectId: projects[0]!.id, id: "1" })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid-target");
          expect(result.failures).toEqual(
            expect.arrayContaining([
              {
                projectId: projects[2]!.id,
                reason: new RequirementIssueError({ operation: "search", reason: "unavailable" })
                  .message,
              },
              {
                projectId: projects[6]!.id,
                reason:
                  "Could not resolve this project's repository. Check that its workspace exists and is a Git repository.",
              },
              {
                projectId: projects[7]!.id,
                reason:
                  "Could not discover issue sources for this repository. Check its issue associations or configure a source in Requirements settings.",
              },
            ]),
          );
          expect(result.failures).toHaveLength(3);
          expect(
            yield* service.list({
              provider: "meituan",
              projectId: projects[4]!.id,
              assignee: "me",
              query: "",
              page: 1,
            }),
          ).toEqual({ groups: [], failures: [] });
          expect(
            (yield* service
              .read({ provider: "meituan", projectId: ProjectId.make("missing"), id: "1" })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid-target");
          const settings = yield* Settings.ServerSettingsService;
          for (const setting of [
            "meituanIntegrationEnabled",
            "meituanRequirementsEnabled",
          ] as const) {
            yield* settings.updateSettings({ [setting]: false });
            const searches = searched.length;
            const probes = discoveries;
            expect(
              yield* service.list({ provider: "meituan", assignee: "all", query: "", page: 1 }),
            ).toEqual({ groups: [], failures: [] });
            expect(
              (yield* service.sources({ projectIds: [projects[0]!.id], refresh: true }))[0]
                ?.sources,
            ).toEqual([]);
            expect(
              (yield* service
                .read({ provider: "meituan", projectId: projects[0]!.id, scope: "456", id: "1" })
                .pipe(Effect.flip)).reason,
            ).toBe("invalid-target");
            expect(searched).toHaveLength(searches);
            expect(discoveries).toBe(probes);
            yield* settings.updateSettings({ [setting]: true });
            expect(
              (yield* service.read({
                provider: "meituan",
                projectId: projects[0]!.id,
                scope: "456",
                id: "1",
              })).title,
            ).toBe("456");
          }
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
          movedToGithub = true;
          const stale = { provider: "meituan" as const, projectId: projects[0]!.id, scope: "789" };
          expect(
            (yield* service
              .create({
                ...stale,
                title: "Test",
                type: "DEVTASK",
                subtype: "",
                body: "",
                assignees: [],
                fields: {},
              })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid-target");
          expect(
            (yield* service.setState({ ...stale, id: "1", state: "done" }).pipe(Effect.flip))
              .reason,
          ).toBe("invalid-target");
        }).pipe(
          Effect.provide(
            Layer.effect(Service.IssueService, Service.make).pipe(
              Layer.provide(Layer.mergeAll(KeyValueStore.layerMemory, NodeCrypto.layer)),
              Layer.provide(
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  scratchRoot: Effect.succeedSome("/scratch"),
                }),
              ),
              Layer.provide(
                Layer.mock(Projects.ProjectService)({
                  getShell: (id, _cwd, refresh) =>
                    Effect.succeed(
                      Option.fromUndefinedOr(projects.find((project) => project.id === id)).pipe(
                        Option.map((project) =>
                          refresh === "refresh" && movedToGithub
                            ? {
                                ...project,
                                repositoryIdentity: {
                                  provider: SourceControlProviderKind.make("github"),
                                  canonicalKey: "github.com/acme/moved",
                                  locator: {
                                    source: "git-remote" as const,
                                    remoteName: "origin",
                                    remoteUrl: "https://github.com/acme/moved.git",
                                  },
                                },
                              }
                            : project,
                        ),
                      ),
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
                  resolveHandle: ({ cwd }) => {
                    resolved.push(cwd);
                    if (cwd === "/local-folder")
                      return Effect.fail(
                        new SourceControlProviderError({
                          provider: SourceControlProviderKind.make("unknown"),
                          cwd,
                          operation: "detectProvider",
                          detail: "Failed to detect source control provider.",
                          cause: new VcsUnsupportedOperationError({
                            operation: "VcsDriverRegistry.resolve",
                            kind: VcsDriverKind.make("unknown"),
                            detail: "No supported VCS repository was detected.",
                          }),
                        }),
                      );
                    if (
                      ["/scratch", "/archived", "/not-a-repository", "/manual-offline"].includes(
                        cwd,
                      )
                    )
                      return Effect.fail(
                        new SourceControlProviderError({
                          provider: SourceControlProviderKind.make("unknown"),
                          cwd,
                          operation: "detectProvider",
                          detail: "Not a Git repository",
                        }),
                      );
                    return Effect.succeed({
                      provider,
                      context: {
                        provider: {
                          kind: provider.kind,
                          name: "Meituan",
                          baseUrl: "https://git.sankuai.com",
                        },
                        remoteName: "origin",
                        remoteUrl: `https://git.sankuai.com/team/${cwd === "/discovery-offline" ? "discovery-offline" : "shared"}.git`,
                      },
                    });
                  },
                }),
              ),
              Layer.provideMerge(
                Settings.ServerSettingsService.layerTest({
                  issueProjectSources: sources,
                  meituanIntegrationEnabled: true,
                }),
              ),
            ),
          ),
        );
      }),
  );
});
