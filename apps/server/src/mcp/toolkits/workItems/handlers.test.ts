import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as WorkItems from "../../../work-items/WorkItemService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

it.effect("refuses a task participant whose runtime exceeds the calling agent", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({
      name: "work_item_start",
      arguments: {
        id: "task-1",
        commandId: "start-1",
        specRevision: 1,
        participants: [
          {
            assignment: "Implement the UI",
            modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("runtime_mode_escalation_denied"),
        }),
      ]),
    );
  }).pipe(
    Effect.provide(
      McpHttpServer.layerWorkItemToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(
          Layer.mock(WorkItems.WorkItemService)({
            mutate: () => Effect.die("An unauthorized task must never be dispatched"),
          }),
        ),
        Layer.provide(
          Layer.mock(Threads.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(liveThreadShell(id, { runtimeMode: "approval-required" })),
          }),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
    Effect.provideService(Invocation.McpInvocationContext, {
      environmentId: EnvironmentId.make("test-environment"),
      requestNamespace: "test-session",
      issuedAt: 0,
      thread: {
        threadId: ThreadId.make("caller"),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration"] as const),
    }),
    Effect.provideService(McpSchema.McpServerClient, {
      clientId: 1,
      protocolVersion: "2025-06-18",
      clientCapabilities: {},
      clientInfo: { name: "test", version: "1" },
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
      getClient: Effect.die("unused"),
    }),
  ),
);
