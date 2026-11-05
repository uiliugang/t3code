import { describe, expect, it } from "@effect/vitest";
import { IssueError, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "./SourceControlProviderRegistry.ts";
import * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Service from "./IssueService.ts";

describe("IssueService", () => {
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
        const provider = yield* Provider.SourceControlProvider.pipe(
          Effect.provide(
            Layer.mock(Provider.SourceControlProvider)({
              kind: SourceControlProviderKind.make("meituan"),
              issueBoard: {
                read: () => Effect.die("unexpected read"),
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
          expect(searched.toSorted()).toEqual(["1031008", "123"]);
          expect(result.groups.map((group) => group.projectIds)).toEqual([
            [projects[0]!.id, projects[1]!.id],
          ]);
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
        }).pipe(
          Effect.provide(
            Service.layer.pipe(
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
