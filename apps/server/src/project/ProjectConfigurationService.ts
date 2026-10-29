import {
  CommandId,
  defaultInstanceIdForDriver,
  ProjectConfigurationExportInput,
  ProjectImportDefinition,
  ProjectImportError,
  ProjectImportSnapshot,
  ProjectImportStartInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  WorkspaceRootId,
  ProjectWorkspaceConfigInput,
  type ProjectSettingsOverrides,
  type Project,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { canonicalRepositoryCloneKey } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";

const SavedImport = Schema.Struct({
  ...ProjectImportSnapshot.fields,
  configurations: Schema.Array(ProjectImportDefinition),
  rootKeys: Schema.Array(Schema.Array(Schema.String)),
});
type SavedImport = typeof SavedImport.Type;
const importsCodec = Schema.fromJsonString(Schema.Array(SavedImport));
const decodeImports = Schema.decodeUnknownEffect(importsCodec);
const encodeImports = Schema.encodeEffect(importsCodec);
const isProjectImportError = Schema.is(ProjectImportError);
const sameWorkspaceConfig = Schema.toEquivalence(ProjectWorkspaceConfigInput);
const sameConfigurations = Schema.toEquivalence(Schema.Array(ProjectImportDefinition));

export class ProjectConfigurationService extends Context.Service<
  ProjectConfigurationService,
  {
    readonly exportProjects: (input: typeof ProjectConfigurationExportInput.Type) => Effect.Effect<
      ReadonlyArray<{
        readonly projectId: ProjectId;
        readonly configuration: ProjectImportDefinition;
      }>,
      ProjectImportError
    >;
    readonly start: (
      input: ProjectImportStartInput,
    ) => Effect.Effect<ProjectImportSnapshot, ProjectImportError>;
    readonly retry: (id: string) => Effect.Effect<ProjectImportSnapshot, ProjectImportError>;
    readonly forget: (id: string) => Effect.Effect<void, ProjectImportError>;
    readonly stream: Stream.Stream<ReadonlyArray<ProjectImportSnapshot>, ProjectImportError>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/project/ProjectConfigurationService") {}

function safeCloneUrl(remote: string | undefined): string | null {
  if (!remote || canonicalRepositoryCloneKey(remote) === null) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) return remote;
  const url = new URL(remote);
  url.password = "";
  if (url.protocol !== "ssh:") url.username = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function providerIds(settings: ProjectSettingsOverrides) {
  return new Set([
    ...Object.keys(settings.providerInstances ?? {}).map((id) => ProviderInstanceId.make(id)),
    ...[
      settings.defaultModelSelection,
      settings.textGenerationModelSelection,
      settings.sourceControlWriterModelSelection,
      settings.reviewGuideModelSelection,
    ].flatMap((selection) => (selection ? [selection.instanceId] : [])),
  ]);
}

function publicSnapshot({
  configurations: _configurations,
  rootKeys: _rootKeys,
  ...snapshot
}: SavedImport): ProjectImportSnapshot {
  return snapshot;
}

function pauseImport(record: SavedImport): SavedImport {
  return {
    ...record,
    phase: "paused",
    repositories: record.repositories.map((root) =>
      root.phase === "running" ? { ...root, phase: "failed", failure: "interrupted" } : root,
    ),
  };
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const home = yield* HostProcess.HomeDirectory;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const statePath = path.join(config.stateDir, "project-imports.json");
  const lock = yield* Semaphore.make(1);
  const actionLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<ReadonlyArray<ProjectImportSnapshot>>();
  const initial = yield* fs.exists(statePath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(statePath).pipe(Effect.flatMap(decodeImports))
        : Effect.succeed<ReadonlyArray<SavedImport>>([]),
    ),
    Effect.mapError((cause) => new ProjectImportError({ operation: "read", cause })),
  );
  const records = yield* Ref.make<ReadonlyArray<SavedImport>>(
    initial.map((record) => (record.phase === "running" ? pauseImport(record) : record)),
  );

  const persist = Effect.fn("ProjectConfigurationService.persist")(function* (
    transform: (current: ReadonlyArray<SavedImport>) => ReadonlyArray<SavedImport>,
  ) {
    const next = transform(yield* Ref.get(records));
    const contents = yield* encodeImports(next).pipe(
      Effect.mapError((cause) => new ProjectImportError({ operation: "save", cause })),
    );
    yield* writeFileStringAtomically({ filePath: statePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new ProjectImportError({ operation: "save", cause })),
    );
    yield* Ref.set(records, next);
    yield* PubSub.publish(changes, next.map(publicSnapshot));
  }, lock.withPermits(1));

  const update = Effect.fn("ProjectConfigurationService.update")(function* (
    id: string,
    transform: (record: SavedImport) => SavedImport,
  ) {
    yield* persist((current) =>
      current.map((record) => (record.id === id ? transform(record) : record)),
    );
  });
  const read = Effect.fn("ProjectConfigurationService.read")(function* (id: string) {
    const record = (yield* Ref.get(records)).find((entry) => entry.id === id);
    if (!record)
      return yield* new ProjectImportError({ operation: "read", cause: "Import not found" });
    return record;
  });

  const relativeDirectory = (root: string, directory: string) => {
    const relative = path.relative(root, directory);
    return path.isAbsolute(relative) || relative.split(path.sep).includes("..")
      ? null
      : relative.replaceAll("\\", "/");
  };
  const physicalPath = Effect.fn("ProjectConfigurationService.physicalPath")((value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value))),
  );

  const exportProjects = Effect.fn("ProjectConfigurationService.exportProjects")(
    function* (input: typeof ProjectConfigurationExportInput.Type) {
      const snapshot = yield* projects.snapshot;
      const server = yield* settings.getSettings;
      return yield* Effect.forEach(
        snapshot.projects.filter(
          (project) => !input.projectIds || input.projectIds.includes(project.id),
        ),
        (project) =>
          Effect.gen(function* () {
            const roots = project.workspaceConfig?.roots ?? [
              {
                id: WorkspaceRootId.make(project.id),
                alias: "main",
                sourcePath: project.workspaceRoot,
                description: "",
                defaultSelected: true,
                accessIntent: "write" as const,
              },
            ];
            const exportedRoots = yield* Effect.forEach(roots, (root) =>
              Effect.gen(function* () {
                const resolved = yield* identities.resolve(root.sourcePath);
                const identity =
                  resolved ??
                  (root.sourcePath === project.workspaceRoot ? project.repositoryIdentity : null);
                const directory = identity?.rootPath
                  ? relativeDirectory(
                      yield* physicalPath(identity.rootPath),
                      yield* physicalPath(root.sourcePath),
                    )
                  : "";
                if (directory === null)
                  return yield* new ProjectImportError({
                    operation: "export",
                    cause: `Could not determine the repository subdirectory for ${project.title}. Restore its checkout before exporting.`,
                  });
                return {
                  id: root.id,
                  alias: root.alias,
                  description: root.description,
                  defaultSelected: root.defaultSelected,
                  accessIntent: root.accessIntent,
                  ...(root.defaultBaseRef ? { defaultBaseRef: root.defaultBaseRef } : {}),
                  ...(root.setupScript ? { setupScript: root.setupScript } : {}),
                  remoteUrl: safeCloneUrl(
                    identity?.origin ? identity.origin.remoteUrl : identity?.locator.remoteUrl,
                  ),
                  directory,
                };
              }),
            );
            const overrides = resolveProjectSettings(server, project.id, project).overrides;
            return {
              projectId: project.id,
              configuration: {
                name: project.title,
                settings: overrides,
                providers: Object.fromEntries(
                  [...providerIds(overrides)].map((id) => [
                    id,
                    server.providerInstances[id]?.driver ?? ProviderDriverKind.make(id),
                  ]),
                ),
                workspace: {
                  grouped: project.workspaceConfig !== undefined,
                  primaryRootId: project.workspaceConfig?.primaryRootId ?? roots[0]!.id,
                  roots: exportedRoots,
                },
              },
            };
          }),
      );
    },
    Effect.mapError((cause) =>
      isProjectImportError(cause) ? cause : new ProjectImportError({ operation: "export", cause }),
    ),
  );

  const cloneRepository = Effect.fn("ProjectConfigurationService.cloneRepository")(function* (
    id: string,
    key: string,
  ) {
    const record = yield* read(id);
    const repository = record.repositories.find((entry) => entry.key === key)!;
    if (repository.phase === "ready" && (yield* fs.exists(repository.destinationPath))) return;
    if (!repository.remoteUrl) {
      yield* update(id, (entry) => ({
        ...entry,
        repositories: entry.repositories.map((root) =>
          root.key === key ? { ...root, phase: "failed", failure: "missing_remote" } : root,
        ),
      }));
      return;
    }
    yield* update(id, (entry) => ({
      ...entry,
      repositories: entry.repositories.map((root) =>
        root.key === key ? { ...root, phase: "running", failure: null } : root,
      ),
    }));
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        if (yield* fs.exists(repository.destinationPath)) {
          const identity = yield* identities.resolve(repository.destinationPath, { refresh: true });
          const existingKey = identity
            ? canonicalRepositoryCloneKey(identity.origin?.remoteUrl ?? identity.locator.remoteUrl)
            : null;
          if (
            existingKey !== key ||
            !identity?.rootPath ||
            (yield* physicalPath(identity.rootPath)) !==
              (yield* physicalPath(repository.destinationPath))
          )
            return yield* Effect.fail("destination_conflict" as const);
          return;
        }
        yield* fs.makeDirectory(record.destinationDirectory, { recursive: true });
        let stagingPath =
          repository.cloned && repository.stagingPath && (yield* fs.exists(repository.stagingPath))
            ? repository.stagingPath
            : null;
        if (!stagingPath) {
          stagingPath = yield* fs.makeTempDirectory({
            directory: record.destinationDirectory,
            prefix: ".t3-import-",
          });
          const staged = stagingPath;
          yield* update(id, (entry) => ({
            ...entry,
            repositories: entry.repositories.map((root) =>
              root.key === key ? { ...root, stagingPath: staged, cloned: false } : root,
            ),
          }));
          yield* repositories.cloneRepository({
            remoteUrl: repository.remoteUrl!,
            destinationPath: stagingPath,
          });
          yield* update(id, (entry) => ({
            ...entry,
            repositories: entry.repositories.map((root) =>
              root.key === key ? { ...root, cloned: true } : root,
            ),
          }));
        }
        yield* fs.rename(stagingPath, repository.destinationPath);
      }),
    );
    const failure = Result.isFailure(outcome) ? outcome.failure : null;
    let category: (typeof ProjectImportSnapshot.Type.repositories)[number]["failure"] = null;
    if (failure !== null) {
      category = failure === "destination_conflict" ? "destination_conflict" : "clone_failed";
      if (PlatformError.isPlatformError(failure)) category = "filesystem_failed";
      if (
        typeof failure === "object" &&
        "cause" in failure &&
        typeof failure.cause === "object" &&
        failure.cause !== null &&
        "reason" in failure.cause
      ) {
        if (
          failure.cause.reason === "authentication_failed" ||
          failure.cause.reason === "host_key_unverified"
        )
          category = failure.cause.reason;
      }
    }
    yield* update(id, (entry) => ({
      ...entry,
      repositories: entry.repositories.map((root) =>
        root.key === key
          ? { ...root, phase: category ? "failed" : "ready", failure: category }
          : root,
      ),
    }));
  });

  const createProject = Effect.fn("ProjectConfigurationService.createProject")(function* (
    id: string,
    index: number,
  ) {
    const record = yield* read(id);
    const state = record.projects[index]!;
    if (state.phase === "ready") return;
    const definition = record.configurations[index]!;
    const grouped = definition.workspace.grouped !== false;
    const rootStates = record.rootKeys[index]!.map((key) =>
      record.repositories.find((root) => root.key === key)!,
    );
    if (rootStates.some((root) => root.phase !== "ready")) return;
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const roots = yield* Effect.forEach(definition.workspace.roots, (root, rootIndex) =>
          Effect.gen(function* () {
            const repository = rootStates[rootIndex]!;
            const sourcePath = path.resolve(repository.destinationPath, root.directory);
            const realRepository = yield* fs.realPath(repository.destinationPath);
            const realSource = yield* fs.realPath(sourcePath);
            if (
              relativeDirectory(realRepository, realSource) === null ||
              (yield* fs.stat(realSource)).type !== "Directory"
            )
              return yield* Effect.fail("project_failed" as const);
            return {
              id: WorkspaceRootId.make(`${state.projectId}:root:${rootIndex}`),
              alias: root.alias,
              sourcePath: realSource,
              description: root.description,
              defaultSelected: root.defaultSelected,
              accessIntent: root.accessIntent,
              ...(root.defaultBaseRef ? { defaultBaseRef: root.defaultBaseRef } : {}),
            };
          }),
        );
        const primaryIndex = definition.workspace.roots.findIndex(
          (root) => root.id === definition.workspace.primaryRootId,
        );
        const primary = roots[primaryIndex]!;
        const previous = yield* projects.getById(state.projectId);
        let project: Project;
        if (Option.isSome(previous)) {
          project = previous.value;
        } else {
          const snapshot = yield* projects.snapshot;
          const sameWorkspace = yield* Effect.findFirst(snapshot.projects, (candidate) =>
            Effect.gen(function* () {
              if (
                (grouped && candidate.title !== definition.name) ||
                (candidate.workspaceConfig !== undefined) !== grouped
              )
                return false;
              if ((yield* physicalPath(candidate.workspaceRoot)) !== primary.sourcePath)
                return false;
              const existingRoots = candidate.workspaceConfig?.roots;
              if (!existingRoots) return roots.length === 1;
              const resolvedRoots = yield* Effect.forEach(existingRoots, (root) =>
                physicalPath(root.sourcePath).pipe(
                  Effect.map((sourcePath) => ({ ...root, sourcePath })),
                ),
              );
              return (
                resolvedRoots.length === roots.length &&
                roots.every((root) =>
                  resolvedRoots.some(
                    (entry) => entry.alias === root.alias && entry.sourcePath === root.sourcePath,
                  ),
                )
              );
            }),
          );
          project =
            Option.getOrUndefined(sameWorkspace) ??
            (yield* projects.create({
              commandId: CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
              projectId: state.projectId,
              title: definition.name,
              workspaceRoot: primary.sourcePath,
              ...(grouped ? { workspaceConfig: { primaryRootId: primary.id, roots } } : {}),
            }));
          if (project.id !== state.projectId)
            yield* update(id, (entry) => ({
              ...entry,
              projects: entry.projects.map((item, itemIndex) =>
                itemIndex === index ? { ...item, projectId: project.id } : item,
              ),
            }));
        }
        const targetIds = new Map(
          definition.workspace.roots.map((root, rootIndex) => [
            root.id,
            project.workspaceConfig?.roots.find((candidate) => candidate.alias === root.alias)
              ?.id ?? (grouped ? roots[rootIndex]!.id : WorkspaceRootId.make(project.id)),
          ]),
        );
        const remapScript = (
          script: NonNullable<ProjectSettingsOverrides["defaultProjectScripts"]>[number],
        ) => ({
          ...script,
          ...(script.repositoryRootIds
            ? {
                repositoryRootIds: script.repositoryRootIds.map((sourceId) =>
                  targetIds.get(sourceId)!,
                ),
              }
            : {}),
        });
        const desiredRoots = roots.map((root, rootIndex) => ({
          ...root,
          id: targetIds.get(definition.workspace.roots[rootIndex]!.id)!,
          ...(definition.workspace.roots[rootIndex]!.setupScript
            ? { setupScript: remapScript(definition.workspace.roots[rootIndex]!.setupScript!) }
            : {}),
        }));
        const desiredWorkspace = {
          primaryRootId: desiredRoots[primaryIndex]!.id,
          roots: desiredRoots,
        };
        if (
          grouped &&
          (!project.workspaceConfig ||
            !sameWorkspaceConfig(project.workspaceConfig, desiredWorkspace))
        ) {
          project = yield* projects.update({
            commandId: CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
            projectId: project.id,
            workspaceConfig: desiredWorkspace,
            expectedWorkspaceVersion: project.workspaceConfig?.version ?? 0,
          });
        }
        const server = yield* settings.getSettings;
        for (const instanceId of providerIds(definition.settings)) {
          const defaultDriver = BUILT_IN_DRIVERS.find(
            (driver) =>
              defaultInstanceIdForDriver(driver.driverKind) === instanceId &&
              driver.metadata.hasDefaultInstance !== false,
          );
          const destinationDriver =
            server.providerInstances[instanceId]?.driver ?? defaultDriver?.driverKind;
          if (destinationDriver !== definition.providers[instanceId])
            return yield* Effect.fail("settings_failed" as const);
        }
        const scripts = definition.settings.defaultProjectScripts?.map(remapScript);
        yield* settings
          .updateSettings({
            projectSettingsOverrides: {
              [project.id]:
                Object.keys(definition.settings).length === 0
                  ? null
                  : {
                      ...definition.settings,
                      providerInstances: definition.settings.providerInstances ?? {},
                      ...(scripts ? { defaultProjectScripts: scripts } : {}),
                    },
            },
          })
          .pipe(Effect.mapError(() => "settings_failed" as const));
      }),
    );
    yield* update(id, (entry) => ({
      ...entry,
      projects: entry.projects.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              phase: Result.isSuccess(result) ? "ready" : "failed",
              failure:
                Result.isFailure(result) && result.failure === "settings_failed"
                  ? "settings_failed"
                  : Result.isFailure(result)
                    ? "project_failed"
                    : null,
            }
          : item,
      ),
    }));
  });

  const process = Effect.fn("ProjectConfigurationService.process")(function* (id: string) {
    const record = yield* read(id);
    for (const repository of record.repositories) yield* cloneRepository(id, repository.key);
    // Ordinary projects must register first because groups may share their primary directory.
    const projectOrder = record.configurations
      .map((definition, index) => ({ index, grouped: definition.workspace.grouped !== false }))
      .sort((left, right) => Number(left.grouped) - Number(right.grouped));
    for (const { index } of projectOrder) yield* createProject(id, index);
    yield* update(id, (entry) => ({
      ...entry,
      phase: entry.projects.every((project) => project.phase === "ready") ? "done" : "partial",
    }));
  });
  const worker = yield* makeDrainableWorker((id: string) =>
    process(id).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? update(id, pauseImport).pipe(Effect.ignoreCause({ log: true }))
          : Effect.void,
      ),
    ),
  );

  const start = Effect.fn("ProjectConfigurationService.start")(
    function* (input: ProjectImportStartInput) {
      const expandedDirectory = expandHomePath(
        input.destinationDirectory ?? path.join(home, "projects"),
        home,
      );
      if (!path.isAbsolute(expandedDirectory))
        return yield* new ProjectImportError({
          operation: "start",
          cause: "Choose an absolute directory or a home-relative directory.",
        });
      const destinationDirectory = path.resolve(expandedDirectory);
      const configurations = input.projects.map((project) => ({
        ...project,
        workspace: {
          ...project.workspace,
          roots: project.workspace.roots.map((root) => ({
            ...root,
            remoteUrl: safeCloneUrl(root.remoteUrl ?? undefined),
          })),
        },
      }));
      const current = (yield* Ref.get(records)).find((entry) => entry.id === input.id);
      if (current) {
        if (
          current.destinationDirectory !== destinationDirectory ||
          !sameConfigurations(current.configurations, configurations)
        )
          return yield* new ProjectImportError({
            operation: "start",
            cause:
              "This import already started with different settings or a different directory. Choose the file again to start a separate import.",
          });
        return publicSnapshot(current);
      }
      const rootStates = new Map<
        string,
        (typeof ProjectImportSnapshot.Type.repositories)[number]
      >();
      const rootKeys = [];
      for (const [projectIndex, project] of configurations.entries()) {
        const keys = [];
        for (const root of project.workspace.roots) {
          const key = root.remoteUrl
            ? canonicalRepositoryCloneKey(root.remoteUrl)!
            : `missing:${projectIndex}:${root.id}`;
          keys.push(key);
          if (!rootStates.has(key)) {
            const hash = Hex.encode(
              yield* crypto.digest("SHA-256", new TextEncoder().encode(key)).pipe(Effect.orDie),
            );
            rootStates.set(key, {
              key,
              remoteUrl: root.remoteUrl,
              destinationPath: path.join(destinationDirectory, `repository-${hash}`),
              phase: "pending",
              failure: null,
              stagingPath: null,
              cloned: false,
            });
          }
        }
        rootKeys.push(keys);
      }
      const projectStates = yield* Effect.forEach(configurations, (project) =>
        crypto.randomUUIDv4().pipe(
          Effect.orDie,
          Effect.map((uuid) => ({
            projectId: ProjectId.make(uuid),
            name: project.name,
            phase: "pending" as const,
            failure: null,
          })),
        ),
      );
      const record: SavedImport = {
        id: input.id,
        destinationDirectory,
        phase: "running",
        configurations,
        rootKeys,
        repositories: [...rootStates.values()],
        projects: projectStates,
      };
      // Persist intent before enqueueing; retries and server restarts retain every repository and setting.
      yield* Effect.uninterruptible(
        persist((entries) => [...entries, record]).pipe(Effect.andThen(worker.enqueue(input.id))),
      );
      return publicSnapshot(record);
    },
    Effect.mapError((cause) =>
      isProjectImportError(cause) ? cause : new ProjectImportError({ operation: "start", cause }),
    ),
  );

  const retry = Effect.fn("ProjectConfigurationService.retry")(function* (id: string) {
    const record = yield* read(id);
    if (record.phase === "running" || record.phase === "done") return publicSnapshot(record);
    yield* Effect.uninterruptible(
      update(id, (entry) => ({ ...entry, phase: "running" })).pipe(
        Effect.andThen(worker.enqueue(id)),
      ),
    );
    return publicSnapshot({ ...record, phase: "running" });
  });
  const forget = Effect.fn("ProjectConfigurationService.forget")(function* (id: string) {
    const record = yield* read(id);
    if (record.phase === "running")
      return yield* new ProjectImportError({ operation: "forget", cause: "Import is running" });
    yield* persist((entries) => entries.filter((entry) => entry.id !== id));
  });
  const stream = Stream.callback<ReadonlyArray<ProjectImportSnapshot>>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, (yield* Ref.get(records)).map(publicSnapshot));
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((snapshots) =>
            Effect.sync(() => Queue.offerUnsafe(mailbox, snapshots)),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );
  return ProjectConfigurationService.of({
    exportProjects,
    start: Effect.fn("ProjectConfigurationService.startLocked")((input) =>
      actionLock.withPermits(1)(start(input)),
    ),
    retry: Effect.fn("ProjectConfigurationService.retryLocked")((id) =>
      actionLock.withPermits(1)(retry(id)),
    ),
    forget: Effect.fn("ProjectConfigurationService.forgetLocked")((id) =>
      actionLock.withPermits(1)(forget(id)),
    ),
    stream,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ProjectConfigurationService, make);
