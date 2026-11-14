import { ThreadId, type OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { parseAttachmentFileExtension, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<
  ResourceCleanupError,
  { readonly brand: unique symbol }
>()("ResourceCleanupError", {
  operation: Schema.Literals([
    "terminal",
    "preview",
    "device",
    "attachment",
    "scheduled-tasks",
    "runtime",
  ]),
  threadId: Schema.optional(Schema.String),
  attachmentId: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly runtimeThreadIds: Effect.Effect<ReadonlyArray<ThreadId>>;
  readonly cleanupRuntime: (input: {
    readonly threadId: ThreadId;
    readonly mode: "settled" | "removed";
  }) => Effect.Effect<boolean, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    runtimeThreadIds: Effect.succeed([]),
    cleanupRuntime: () => Effect.succeed(true),
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const ports = yield* PortScanner.PortDiscovery;
    const devices = yield* DeviceService.DeviceService;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const readThread = Effect.fn("ResourceCleanupService.readThread")(function* (
      threadId: ThreadId,
    ) {
      return yield* projections
        .getThread(threadId)
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          Effect.orDie,
        );
    });
    const retirementKey = (thread: OrchestrationV2AppThread, mode: "settled" | "removed") => {
      if (
        mode === "removed"
          ? thread.archivedAt === null && thread.deletedAt === null
          : thread.settledOverride !== "settled"
      )
        return null;
      return JSON.stringify(
        [thread.settledAt, thread.archivedAt, thread.deletedAt].map((at) =>
          at === null ? null : DateTime.toEpochMillis(at),
        ),
      );
    };
    return {
      runtimeThreadIds: Effect.gen(function* () {
        const servers = yield* ports.scan([], { refreshAgents: true });
        const ids = servers.flatMap((server) => {
          const id = server.terminal?.threadId ?? server.agent?.threadId;
          return id === undefined ? [] : [id];
        });
        return [
          ...new Set([
            ...(yield* devices.state).sessions.map((session) => session.threadId),
            ...ids,
          ]),
        ];
      }),
      cleanupScheduledTasks: Effect.fn("ResourceCleanupService.cleanupScheduledTasks")(function (
        threadId: ThreadId,
      ) {
        return scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          );
      }),
      cleanupRuntime: Effect.fn("ResourceCleanupService.cleanupRuntime")(function* ({
        threadId,
        mode,
      }) {
        const thread = yield* readThread(threadId);
        const key = thread === null ? null : retirementKey(thread, mode);
        if (key === null) return false;
        const shouldRelease = readThread(threadId).pipe(
          Effect.map((current) => current !== null && retirementKey(current, mode) === key),
        );
        const sessions = yield* devices.sessionsForThread(threadId);
        const wrapCleanup = <E>(cleanup: Effect.Effect<void, E>) =>
          cleanup.pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "runtime", threadId, cause }),
            ),
          );
        const cleanups = [
          wrapCleanup(ports.stopThreadServers({ threadId, shouldStop: shouldRelease, mode })),
          wrapCleanup(
            terminals.closeOnSettle({
              threadId,
              shouldClose: shouldRelease,
              deleteHistory: mode === "removed",
            }),
          ),
          ...sessions.map((session) => wrapCleanup(devices.closeRetired(session, shouldRelease))),
        ];
        const [, failures] = yield* Effect.partition(cleanups, (cleanup) => cleanup);
        const [failure] = failures;
        if (failure !== undefined) return yield* failure;
        return yield* shouldRelease;
      }),
      cleanupPreviews: Effect.fn("ResourceCleanupService.cleanupPreviews")(function (
        threadId: string,
      ) {
        return previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          );
      }),
      cleanupAttachments: Effect.fn("ResourceCleanupService.cleanupAttachments")(function (
        attachmentIds: ReadonlyArray<string>,
      ) {
        return Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const extension = parseAttachmentFileExtension(attachmentId);
            const path =
              resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId,
              }) ??
              (extension
                ? resolveAttachmentRelativePath({
                    attachmentsDir: config.attachmentsDir,
                    relativePath: `${attachmentId}.${extension}`,
                  })
                : null);
            return path === null
              ? Effect.void
              : fileSystem.remove(path, { force: true }).pipe(
                  Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true })),
                  Effect.mapError(
                    (cause) =>
                      new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                  ),
                );
          },
          { discard: true, concurrency: 4 },
        );
      }),
    };
  }),
);
