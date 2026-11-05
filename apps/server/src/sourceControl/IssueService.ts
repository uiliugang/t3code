import {
  IssueError,
  SourceControlProviderKind,
  type IssueTarget,
  type IssueListInput,
  type IssueListResult,
  type IssueCreateInput,
  type IssueMetadataInput,
  type IssuePeopleInput,
  type IssueReadInput,
  type IssueSetStateInput,
  type IssueSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "./SourceControlProviderRegistry.ts";
import * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";

type Board = NonNullable<Provider.SourceControlProvider["Service"]["issueBoard"]>;
export class IssueService extends Context.Service<
  IssueService,
  {
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

const make = Effect.gen(function* () {
  const projects = yield* Projects.ProjectService;
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* Providers.SourceControlProviderRegistry;
  const resolve = Effect.fn("IssueService.resolve")(function* (input: IssueTarget) {
    const project = yield* projects
      .getShell(input.projectId)
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
    let source = saved.issueProjectSources[input.projectId]?.find(
      (entry) => entry.provider === input.provider,
    );
    if (!source && input.provider === "github") {
      const handle = yield* providers
        .resolveHandle({ cwd })
        .pipe(
          Effect.mapError(
            (cause) => new IssueError({ operation: "repository", reason: "unavailable", cause }),
          ),
        );
      if (handle.provider.kind === "github" && handle.context) {
        const scope = Provider.repositoryPathFromRemoteUrl(handle.context.remoteUrl);
        const host = new URL(handle.context.provider.baseUrl).hostname;
        if (scope) source = { provider: "github", scope, host };
      }
    }
    if (
      !source ||
      (source.provider === "meituan"
        ? !/^[1-9]\d*$/u.test(source.scope) || source.host !== "mep.sankuai.com"
        : !/^[\w.-]+\/[\w.-]+$/u.test(source.scope) || !/^[\w.-]+$/u.test(source.host))
    )
      return yield* new IssueError({ operation: "resolve", reason: "invalid-target" });
    const provider = yield* providers
      .get(SourceControlProviderKind.make(input.provider))
      .pipe(
        Effect.mapError(
          (cause) => new IssueError({ operation: "provider", reason: "unsupported", cause }),
        ),
      );
    if (!provider.issueBoard)
      return yield* new IssueError({ operation: "provider", reason: "unsupported" });
    return { cwd, source: source as IssueSource, board: provider.issueBoard };
  });
  return IssueService.of({
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
          resolve({ projectId: project.id, provider: input.provider }).pipe(
            Effect.map((target) => ({ projectId: project.id, target })),
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
        const { projectId, target } = entry.success;
        const key = `${target.source.provider}\n${target.source.host}\n${target.source.scope}`;
        const existing = distinct.get(key);
        if (existing) existing.projectIds.push(projectId);
        else distinct.set(key, { target, projectIds: [projectId] });
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
export const layer = Layer.effect(IssueService, make);
