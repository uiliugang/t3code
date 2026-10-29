import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SourceControlProviderKind,
  SourceControlRepositoryError,
  WorkspaceRootId,
  GitCommandError,
  type Project,
  type ProjectImportDefinition,
  type ProjectImportSnapshot,
  type RepositoryIdentity,
  type SourceControlCloneRepositoryInput,
} from "@t3tools/contracts";
import { canonicalRepositoryCloneKey } from "@t3tools/shared/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectConfigurationService from "./ProjectConfigurationService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

function definition(name: string, remoteUrl: string | null): ProjectImportDefinition {
  const id = WorkspaceRootId.make(name);
  return {
    name,
    settings: { branchNamePrefix: name },
    providers: {},
    workspace: {
      primaryRootId: id,
      roots: [
        {
          id,
          alias: name,
          remoteUrl,
          directory: "",
          description: name,
          defaultSelected: true,
          accessIntent: "write",
        },
      ],
    },
  };
}

const cloneError = (reason?: "authentication_failed") =>
  new SourceControlRepositoryError({
    operation: "cloneRepository",
    provider: SourceControlProviderKind.make("unknown"),
    detail: "Repository unavailable",
    ...(reason
      ? {
          cause: new GitCommandError({
            operation: "clone",
            command: "git",
            cwd: "/fixture",
            detail: "authentication rejected",
            reason,
          }),
        }
      : {}),
  });

const harness = Effect.fn("test.ProjectConfigurationService.harness")(function* (options?: {
  clone?: (
    input: SourceControlCloneRepositoryInput,
    attempt: number,
  ) => Effect.Effect<void, SourceControlRepositoryError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-import-" });
  const attempts: SourceControlCloneRepositoryInput[] = [];
  const registered = new Map<ProjectId, Project>();
  const rejectedCreates = new Set<string>();
  const knownIdentities = new Map<string, RepositoryIdentity>();
  const projectLayer = Layer.mock(ProjectService.ProjectService)({
    snapshot: Effect.sync(() => ({
      projects: [...registered.values()],
      updatedAt: "2026-10-29T00:00:00.000Z",
    })),
    getById: (id) => Effect.sync(() => Option.fromUndefinedOr(registered.get(id))),
    create: (input) =>
      Effect.gen(function* () {
        if (
          rejectedCreates.has(input.commandId) ||
          (input.workspaceConfig === undefined &&
            [...registered.values()].some(
              (project) => project.workspaceRoot === input.workspaceRoot,
            ))
        ) {
          rejectedCreates.add(input.commandId);
          return yield* new ProjectService.ProjectOperationError({
            operation: "dispatch-project-command",
            cause: "The directory already belongs to a project.",
          });
        }
        const project: Project = {
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          ...(input.workspaceConfig
            ? { workspaceConfig: { ...input.workspaceConfig, version: 1 } }
            : {}),
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-29T00:00:00.000Z",
          updatedAt: "2026-10-29T00:00:00.000Z",
          deletedAt: null,
        };
        registered.set(project.id, project);
        return project;
      }),
    update: (input) =>
      Effect.sync(() => {
        const previous = registered.get(input.projectId)!;
        const project = {
          ...previous,
          ...(input.workspaceConfig
            ? {
                workspaceConfig: {
                  ...input.workspaceConfig,
                  version: (previous.workspaceConfig?.version ?? 0) + 1,
                },
              }
            : {}),
        };
        registered.set(project.id, project);
        return project;
      }),
  });
  const repositoriesLayer = Layer.mock(
    SourceControlRepositoryService.SourceControlRepositoryService,
  )({
    cloneRepository: (input) =>
      Effect.gen(function* () {
        attempts.push(input);
        yield* options?.clone?.(input, attempts.length) ?? Effect.void;
        yield* fs.makeDirectory(input.destinationPath, { recursive: true }).pipe(Effect.orDie);
        yield* fs
          .writeFileString(path.join(input.destinationPath, "fixture.remote"), input.remoteUrl!)
          .pipe(Effect.orDie);
        yield* fs
          .makeDirectory(path.join(input.destinationPath, "web"), { recursive: true })
          .pipe(Effect.orDie);
        yield* fs
          .makeDirectory(path.join(input.destinationPath, "api"), { recursive: true })
          .pipe(Effect.orDie);
        return { cwd: input.destinationPath, remoteUrl: input.remoteUrl!, repository: null };
      }),
  });
  const identityLayer = Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
    resolve: (cwd) =>
      Effect.gen(function* () {
        const known = knownIdentities.get(cwd);
        if (known) return known;
        const marker = path.join(cwd, "fixture.remote");
        if (!(yield* fs.exists(marker))) return null;
        const remote = yield* fs.readFileString(marker);
        return {
          canonicalKey: canonicalRepositoryCloneKey(remote)!,
          rootPath: yield* fs.realPath(cwd),
          locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: remote },
        };
      }).pipe(Effect.orDie),
  });
  const layer = ProjectConfigurationService.layer.pipe(
    Layer.provide(projectLayer),
    Layer.provide(repositoriesLayer),
    Layer.provide(identityLayer),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
  );
  return { layer, baseDir, attempts, registered, knownIdentities };
});

const snapshot = Effect.fn("test.ProjectConfigurationService.snapshot")(function* () {
  const service = yield* ProjectConfigurationService.ProjectConfigurationService;
  return Option.getOrThrow(yield* Stream.runHead(service.stream));
});

describe("ProjectConfigurationService", () => {
  it.effect("retries project registration after its rejected command is recorded", () =>
    Effect.gen(function* () {
      const test = yield* harness();
      yield* Effect.gen(function* () {
        const service = yield* ProjectConfigurationService.ProjectConfigurationService;
        const group = definition("workspace", "https://github.com/team/repo.git");
        yield* service.start({
          id: "existing-group",
          destinationDirectory: `${test.baseDir}/clones`,
          projects: [group],
        });
        yield* service.drain;
        yield* service.start({
          id: "ordinary-project",
          destinationDirectory: `${test.baseDir}/clones`,
          projects: [
            { ...group, name: "ordinary", workspace: { ...group.workspace, grouped: false } },
          ],
        });
        yield* service.drain;
        expect((yield* snapshot())[1]?.projects[0]?.failure).toBe("project_failed");
        test.registered.clear();
        yield* service.retry("ordinary-project");
        yield* service.drain;
        expect((yield* snapshot())[1]?.phase).toBe("done");
        expect(test.attempts).toHaveLength(1);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "clones equivalent repositories once, restores workspace groups and does not duplicate a repeated import",
    () =>
      Effect.gen(function* () {
        const test = yield* harness();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${test.baseDir}/clones`);
        yield* fs.symlink(`${test.baseDir}/clones`, `${test.baseDir}/clone-link`);
        const group = definition("frontend", "git@github.com:Team/Repo.git");
        const primary = { ...group.workspace.roots[0]!, directory: "web" };
        const apiRoot = {
          ...primary,
          id: WorkspaceRootId.make("api-root"),
          alias: "api",
          directory: "api",
          remoteUrl: "https://github.com/team/repo.git",
        };
        const projects = [
          { ...group, workspace: { primaryRootId: primary.id, roots: [primary, apiRoot] } },
          {
            ...definition("api-project", "https://github.com/team/repo.git"),
            workspace: { primaryRootId: apiRoot.id, roots: [apiRoot] },
          },
          {
            ...definition("ordinary-project", "https://github.com/team/repo.git"),
            workspace: {
              primaryRootId: primary.id,
              roots: [primary],
              grouped: false,
            },
          },
        ];
        yield* Effect.gen(function* () {
          const service = yield* ProjectConfigurationService.ProjectConfigurationService;
          const input = {
            id: "dedup-import",
            projects,
            destinationDirectory: `${test.baseDir}/clone-link`,
          };
          yield* Effect.all([service.start(input), service.start(input)]);
          yield* service.drain;
          const [record] = yield* snapshot();
          expect(record?.phase).toBe("done");
          expect(record?.repositories).toHaveLength(1);
          expect(test.attempts).toHaveLength(1);
          expect(test.registered.size).toBe(3);
          expect(
            [...test.registered.values()].find((project) => project.title === "ordinary-project")
              ?.workspaceConfig,
          ).toBeUndefined();
          const imported = [...test.registered.values()].find(
            (project) => project.title === "frontend",
          )!;
          expect(
            imported.workspaceConfig?.roots.map((root) => [
              root.alias,
              root.sourcePath.endsWith(root.alias === "api" ? "/api" : "/web"),
            ]),
          ).toEqual([
            ["frontend", true],
            ["api", true],
          ]);
          const exported = yield* service.exportProjects({});
          expect(
            exported.find((entry) => entry.configuration.name === "ordinary-project")?.configuration
              .workspace.grouped,
          ).toBe(false);
          yield* service.start({ ...input, id: "repeat-import" });
          yield* service.drain;
          expect((yield* snapshot())[1]?.phase).toBe("done");
          expect(test.attempts).toHaveLength(1);
          expect(test.registered.size).toBe(3);
          const changedDestination = yield* Effect.exit(
            service.start({ ...input, destinationDirectory: `${test.baseDir}/another-directory` }),
          );
          expect(changedDestination._tag).toBe("Failure");
        }).pipe(Effect.provide(test.layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retains failed clone metadata across service restart and retries only the failed repository",
    () =>
      Effect.gen(function* () {
        let fail = true;
        const test = yield* harness({
          clone: (input) =>
            input.remoteUrl?.includes("private") && fail
              ? Effect.fail(cloneError("authentication_failed"))
              : Effect.void,
        });
        let partial: ProjectImportSnapshot | undefined;
        yield* Effect.gen(function* () {
          const service = yield* ProjectConfigurationService.ProjectConfigurationService;
          yield* service.start({
            id: "failed-import",
            destinationDirectory: `${test.baseDir}/clones`,
            projects: [
              definition("public", "https://github.com/team/public.git"),
              definition("private", "https://user:secret@github.com/team/private.git?token=secret"),
            ],
          });
          yield* service.drain;
          [partial] = yield* snapshot();
          expect(partial?.phase).toBe("partial");
          expect(partial?.repositories.map((root) => root.phase)).toEqual(["ready", "failed"]);
          expect(partial?.repositories[1]?.failure).toBe("authentication_failed");
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const contents = yield* fs.readFileString(`${config.stateDir}/project-imports.json`);
          expect(contents).toContain('"branchNamePrefix":"private"');
          expect(contents).not.toContain("secret");
        }).pipe(Effect.scoped, Effect.provide(test.layer));
        expect(test.attempts).toHaveLength(2);
        fail = false;
        yield* Effect.gen(function* () {
          const service = yield* ProjectConfigurationService.ProjectConfigurationService;
          expect((yield* snapshot())[0]?.phase).toBe("partial");
          expect(test.attempts).toHaveLength(2);
          yield* service.retry("failed-import");
          yield* service.drain;
          expect((yield* snapshot())[0]?.phase).toBe("done");
          expect(test.attempts).toHaveLength(3);
          expect(
            test.attempts.filter((input) => input.remoteUrl?.includes("/public")),
          ).toHaveLength(1);
          yield* service.retry("failed-import");
          yield* service.drain;
          expect(test.attempts).toHaveLength(3);
          const fs = yield* FileSystem.FileSystem;
          expect(yield* fs.exists(partial!.repositories[1]!.stagingPath!)).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(Layer.fresh(test.layer)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "pauses an interrupted import without losing configuration and waits for an explicit retry",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const test = yield* harness({
          clone: (_input, attempt) =>
            attempt === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProjectConfigurationService.ProjectConfigurationService;
          yield* service.start({
            id: "interrupted-import",
            projects: [definition("project", "https://github.com/team/repo.git")],
            destinationDirectory: `${test.baseDir}/clones`,
          });
          yield* Deferred.await(started);
        }).pipe(Effect.scoped, Effect.provide(test.layer));
        yield* Effect.gen(function* () {
          const service = yield* ProjectConfigurationService.ProjectConfigurationService;
          expect((yield* snapshot())[0]?.phase).toBe("paused");
          expect((yield* snapshot())[0]?.repositories[0]?.failure).toBe("interrupted");
          expect(test.attempts).toHaveLength(1);
          yield* service.retry("interrupted-import");
          yield* service.drain;
          expect((yield* snapshot())[0]?.phase).toBe("done");
          expect(test.attempts).toHaveLength(2);
        }).pipe(Effect.scoped, Effect.provide(Layer.fresh(test.layer)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps conflicting destinations and partial checkouts when retrying or forgetting an import",
    () =>
      Effect.gen(function* () {
        const test = yield* harness({ clone: () => Effect.fail(cloneError()) });
        yield* Effect.gen(function* () {
          const service = yield* ProjectConfigurationService.ProjectConfigurationService;
          const fs = yield* FileSystem.FileSystem;
          yield* service.start({
            id: "conflict-import",
            projects: [definition("project", "https://github.com/team/repo.git")],
            destinationDirectory: `${test.baseDir}/clones`,
          });
          yield* service.drain;
          const repository = (yield* snapshot())[0]!.repositories[0]!;
          yield* fs.makeDirectory(repository.destinationPath);
          yield* fs.writeFileString(`${repository.destinationPath}/keep.txt`, "user files");
          yield* service.retry("conflict-import");
          yield* service.drain;
          expect((yield* snapshot())[0]?.repositories[0]?.failure).toBe("destination_conflict");
          expect(test.attempts).toHaveLength(1);
          yield* service.forget("conflict-import");
          expect(yield* snapshot()).toEqual([]);
          expect(yield* fs.readFileString(`${repository.destinationPath}/keep.txt`)).toBe(
            "user files",
          );
          expect(yield* fs.exists(repository.stagingPath!)).toBe(true);
        }).pipe(Effect.provide(test.layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reuses a completed staged clone when moving it into place failed", () =>
    Effect.gen(function* () {
      const test = yield* harness();
      const fs = yield* FileSystem.FileSystem;
      let rejectRename = true;
      const fileSystem = {
        ...fs,
        rename: (from: string, to: string) => {
          if (rejectRename && from.includes(".t3-import-") && to.includes("repository-")) {
            rejectRename = false;
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: to,
              }),
            );
          }
          return fs.rename(from, to);
        },
      };
      yield* Effect.gen(function* () {
        const service = yield* ProjectConfigurationService.ProjectConfigurationService;
        yield* service.start({
          id: "staged-import",
          destinationDirectory: `${test.baseDir}/clones`,
          projects: [definition("project", "https://github.com/team/repo.git")],
        });
        yield* service.drain;
        const failed = (yield* snapshot())[0]!.repositories[0]!;
        expect(failed.failure).toBe("filesystem_failed");
        expect(failed.cloned).toBe(true);
        expect(yield* fs.exists(failed.stagingPath!)).toBe(true);
        yield* service.retry("staged-import");
        yield* service.drain;
        expect((yield* snapshot())[0]?.phase).toBe("done");
        expect(test.attempts).toHaveLength(1);
      }).pipe(
        Effect.provide(
          test.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("exports every repository in a workspace without credentials or machine paths", () =>
    Effect.gen(function* () {
      const test = yield* harness();
      const fs = yield* FileSystem.FileSystem;
      const rootPath = `${test.baseDir}/source`;
      const webPath = `${test.baseDir}/source-link/web`;
      const apiPath = `${test.baseDir}/api`;
      yield* fs.makeDirectory(`${rootPath}/web`, { recursive: true });
      yield* fs.symlink(rootPath, `${test.baseDir}/source-link`);
      yield* fs.makeDirectory(apiPath);
      const primaryId = WorkspaceRootId.make("web");
      const apiId = WorkspaceRootId.make("api");
      const projectId = ProjectId.make("export-source");
      const setupScript = {
        id: "setup",
        name: "Setup",
        command: "vp i",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
        repositoryRootIds: [primaryId],
      };
      test.registered.set(projectId, {
        id: projectId,
        title: "Workspace",
        workspaceRoot: webPath,
        workspaceConfig: {
          version: 1,
          primaryRootId: primaryId,
          roots: [
            {
              id: primaryId,
              alias: "web",
              sourcePath: webPath,
              description: "Frontend",
              accessIntent: "write",
              defaultSelected: true,
              setupScript,
            },
            {
              id: apiId,
              alias: "api",
              sourcePath: apiPath,
              description: "API",
              accessIntent: "write",
              defaultSelected: true,
              defaultBaseRef: "develop",
            },
          ],
        },
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-29T00:00:00.000Z",
        updatedAt: "2026-10-29T00:00:00.000Z",
        deletedAt: null,
      });
      for (const [sourcePath, repositoryRoot, remoteUrl] of [
        [webPath, rootPath, "https://user:secret@github.com/team/web.git?token=secret"],
        [apiPath, apiPath, "git@code.example.test:team/api.git"],
      ]) {
        test.knownIdentities.set(sourcePath!, {
          canonicalKey: "fixture",
          rootPath: yield* fs.realPath(repositoryRoot!),
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: remoteUrl! },
        });
      }
      yield* Effect.gen(function* () {
        const service = yield* ProjectConfigurationService.ProjectConfigurationService;
        const exported = yield* service.exportProjects({ projectIds: [projectId] });
        const roots = exported[0]!.configuration.workspace.roots;
        expect(exported[0]!.configuration.workspace.grouped).toBe(true);
        expect(roots.map((root) => [root.alias, root.remoteUrl, root.directory])).toEqual([
          ["web", "https://github.com/team/web.git", "web"],
          ["api", "git@code.example.test:team/api.git", ""],
        ]);
        expect(roots[0]!.setupScript).toEqual(setupScript);
        expect(roots[1]!.defaultBaseRef).toBe("develop");
        expect(roots.every((root) => !("sourcePath" in root))).toBe(true);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retries settings failures without cloning again and remaps action repository references",
    () =>
      Effect.gen(function* () {
        const test = yield* harness();
        const source = definition("project", "https://github.com/team/repo.git");
        const instanceId = ProviderInstanceId.make("private_codex");
        const project: ProjectImportDefinition = {
          ...source,
          providers: {
            [instanceId]: ProviderDriverKind.make("codex"),
            [ProviderInstanceId.make("codex")]: ProviderDriverKind.make("codex"),
            [ProviderInstanceId.make("acpRegistry")]: ProviderDriverKind.make("acpRegistry"),
          },
          settings: {
            defaultModelSelection: { instanceId, model: "example-model" },
            textGenerationModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "example-model",
            },
            sourceControlWriterModelSelection: {
              instanceId: ProviderInstanceId.make("acpRegistry"),
              model: "example-model",
            },
            defaultProjectScripts: [
              {
                id: "dev",
                name: "Dev",
                command: "vp run dev",
                icon: "play",
                runOnWorktreeCreate: false,
                repositoryRootIds: [source.workspace.primaryRootId],
              },
            ],
          },
        };
        yield* Effect.gen(function* () {
          const service = yield* ProjectConfigurationService.ProjectConfigurationService;
          yield* service.start({
            id: "settings-import",
            projects: [project],
            destinationDirectory: `${test.baseDir}/clones`,
          });
          yield* service.drain;
          expect((yield* snapshot())[0]?.projects[0]?.failure).toBe("settings_failed");
          const settings = yield* ServerSettings.ServerSettingsService;
          const current = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...current.providerInstances,
              [instanceId]: { driver: ProviderDriverKind.make("codex") },
            },
          });
          yield* service.retry("settings-import");
          yield* service.drain;
          expect((yield* snapshot())[0]?.projects[0]?.failure).toBe("settings_failed");
          yield* settings.updateSettings({
            providerInstances: {
              ...(yield* settings.getSettings).providerInstances,
              [ProviderInstanceId.make("acpRegistry")]: {
                driver: ProviderDriverKind.make("acpRegistry"),
              },
            },
          });
          yield* service.retry("settings-import");
          yield* service.drain;
          expect((yield* snapshot())[0]?.phase).toBe("done");
          expect(test.attempts).toHaveLength(1);
          expect(test.registered.size).toBe(1);
          const imported = [...test.registered.values()][0]!;
          expect(
            (yield* settings.getSettings).projectSettingsOverrides[imported.id]
              ?.defaultProjectScripts?.[0]?.repositoryRootIds,
          ).toEqual([imported.workspaceConfig!.primaryRootId]);
        }).pipe(Effect.provide(test.layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
