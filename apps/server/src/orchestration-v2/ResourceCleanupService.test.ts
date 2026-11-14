import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2AppThread,
  DeviceOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as Devices from "../device/DeviceService.ts";
import * as Ports from "../preview/PortScanner.ts";
import * as Previews from "../preview/Manager.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Cleanup from "./ResourceCleanupService.ts";

it.effect("preserves services reactivated while archive cleanup waits for discovery", () =>
  Effect.gen(function* () {
    const discovered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let archivedAt: DateTime.Utc | null = DateTime.makeUnsafe("2026-11-14T00:00:00Z");
    let stopped = false;
    let testFailures = false;
    const released: string[] = [];
    const cleanup = yield* Cleanup.ResourceCleanupService.pipe(
      Effect.provide(
        Cleanup.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              FileSystem.layerNoop({}),
              ServerConfig.layerTest("/test", { prefix: "t3-cleanup-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
              Layer.mock(Devices.DeviceService)({
                sessionsForThread: (threadId) =>
                  Effect.succeed(
                    testFailures
                      ? ["remote", "local"].map((hostId) => ({
                          threadId,
                          hostId,
                          deviceId: "phone",
                          platform: "android" as const,
                          openedAt: "2026-11-14T00:00:00Z",
                        }))
                      : [],
                  ),
                closeRetired: (session, shouldClose) =>
                  shouldClose.pipe(
                    Effect.flatMap((allowed) =>
                      !allowed
                        ? Effect.void
                        : session.hostId === "remote"
                          ? Effect.fail(
                              new DeviceOperationError({
                                operation: "close",
                                reason: "request_failed",
                                cause: new Error("offline fixture"),
                              }),
                            )
                          : Effect.sync(() => {
                              released.push(session.hostId);
                            }),
                    ),
                  ),
              }),
              Layer.mock(Previews.PreviewManager)({}),
              Layer.mock(Tasks.ScheduledTaskService)({}),
              Layer.mock(Projections.ProjectionStoreV2)({
                getThread: () =>
                  Effect.sync((): OrchestrationV2AppThread => ({
                    id: ThreadId.make("retiring"),
                    projectId: ProjectId.make("project"),
                    title: "Thread",
                    providerInstanceId: ProviderInstanceId.make("codex"),
                    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    activeProviderThreadId: null,
                    lineage: {
                      parentThreadId: null,
                      relationshipToParent: null,
                      rootThreadId: ThreadId.make("retiring"),
                    },
                    forkedFrom: null,
                    createdBy: "user",
                    creationSource: "web",
                    createdAt: DateTime.makeUnsafe(0),
                    updatedAt: DateTime.makeUnsafe(0),
                    archivedAt,
                    deletedAt: null,
                    settledAt: null,
                    settledOverride: null,
                    lastVisitedAt: null,
                  })),
              }),
              Layer.mock(Terminals.TerminalManager)({
                close: () => Effect.void,
                closeOnSettle: () => Effect.void,
              }),
              Layer.mock(Ports.PortDiscovery)({
                trackAgent: () => () => undefined,
                stopThreadServers: ({ shouldStop }) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(discovered, undefined);
                    yield* Deferred.await(resume);
                    if (!shouldStop || (yield* shouldStop)) stopped = true;
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    const running = yield* cleanup
      .cleanupRuntime({ threadId: ThreadId.make("retiring"), mode: "removed" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(discovered);
    archivedAt = null;
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(running);
    expect(stopped).toBe(false);
    archivedAt = DateTime.makeUnsafe("2026-11-14T00:00:01Z");
    testFailures = true;
    const retry = yield* Effect.result(
      cleanup.cleanupRuntime({ threadId: ThreadId.make("retiring"), mode: "removed" }),
    );
    expect(retry._tag).toBe("Failure");
    expect(released).toEqual(["local"]);
  }).pipe(Effect.scoped),
);
