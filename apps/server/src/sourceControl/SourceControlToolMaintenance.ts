import {
  SourceControlToolError,
  type SourceControlTool,
  type SourceControlToolId,
  type SourceControlToolStartInput,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as SourceControlToolInstaller from "./SourceControlToolInstaller.ts";
import * as Settings from "../serverSettings.ts";

export class SourceControlToolMaintenance extends Context.Service<
  SourceControlToolMaintenance,
  {
    readonly refresh: Effect.Effect<void>;
    readonly changes: Stream.Stream<ReadonlyArray<SourceControlTool>>;
    readonly start: (
      input: SourceControlToolStartInput,
    ) => Effect.Effect<void, SourceControlToolError>;
  }
>()("t3/sourceControl/SourceControlToolMaintenance") {}

const make = Effect.gen(function* () {
  const installer = yield* SourceControlToolInstaller.SourceControlToolInstaller;
  const settings = yield* Settings.ServerSettingsService;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<ReadonlyArray<SourceControlTool>>([]);
  const isActive = (tools: ReadonlyArray<SourceControlTool>) =>
    tools.some((tool) => tool.phase === "running" || tool.phase === "verifying");
  const update = (id: SourceControlToolId, patch: Partial<SourceControlTool>) =>
    SubscriptionRef.update(state, (tools) =>
      tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)),
    );
  const refresh = lock.withPermits(1)(
    Effect.gen(function* () {
      const previous = yield* SubscriptionRef.get(state);
      if (isActive(previous)) return;
      const saved = yield* settings.getSettings.pipe(
        Effect.orElseSucceed(() => ({ meituanIntegrationEnabled: false })),
      );
      const tools = yield* Effect.forEach(
        (["git", "github", "meituan", "ones2", "mcm", "mtskills"] as const).filter((id) =>
          SourceControlToolInstaller.isSourceControlToolEnabled(id, saved),
        ),
        (id) =>
          installer.inspect(id).pipe(
            Effect.map(({ tool }) => {
              const old = previous.find((entry) => entry.id === id);
              return old ? { ...tool, phase: old.phase, message: old.message } : tool;
            }),
            Effect.catch((error) =>
              Effect.succeed({
                id,
                label: SourceControlToolInstaller.sourceControlToolLabel(id),
                status: "unknown" as const,
                version: null,
                executablePath: null,
                command: null,
                manualCommand: null,
                reason: error.message,
                phase: "idle" as const,
                message: null,
              }),
            ),
          ),
        { concurrency: 3 },
      );
      yield* SubscriptionRef.set(state, tools);
    }),
  );

  const start = Effect.fn("SourceControlToolMaintenance.start")(function* (
    input: SourceControlToolStartInput,
  ) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (isActive(yield* SubscriptionRef.get(state)))
          return yield* new SourceControlToolError({ id: input.id, reason: "busy" });
        const plan = yield* installer.inspect(input.id);
        if (plan.tool.command === null)
          return yield* new SourceControlToolError({ id: input.id, reason: "unsupported" });
        if (
          input.expectedCommand !== plan.tool.command ||
          input.expectedPath !== plan.tool.executablePath ||
          input.expectedVersion !== plan.tool.version
        )
          return yield* new SourceControlToolError({ id: input.id, reason: "changed" });
        const run = Effect.gen(function* () {
          const outcome = yield* installer.install(plan);
          yield* update(input.id, { phase: "verifying" });
          const verified = yield* installer.inspect(input.id);
          if (
            verified.tool.version === null ||
            verified.tool.executablePath === null ||
            (plan.tool.executablePath !== null &&
              plan.tool.executablePath !== verified.tool.executablePath) ||
            (plan.tool.version !== null &&
              compareSemverVersions(verified.tool.version, plan.tool.version) < 0)
          )
            return yield* new SourceControlToolError({ id: input.id, reason: "verification" });
          const unchanged = plan.tool.version === verified.tool.version;
          yield* update(input.id, {
            ...verified.tool,
            phase: unchanged ? "unchanged" : "succeeded",
            message:
              outcome === "current"
                ? "Already up to date."
                : unchanged
                  ? "The version is unchanged. Check the package manager's available version on the server."
                  : "Installation verified.",
          });
        }).pipe(
          Effect.catch((error) => update(input.id, { phase: "failed", message: error.message })),
          Effect.onInterrupt(() =>
            update(input.id, {
              phase: "failed",
              message:
                "Installation was interrupted. Check the tool on the server before retrying.",
            }),
          ),
          Effect.catchCause(() =>
            update(input.id, {
              phase: "failed",
              message: new SourceControlToolError({ id: input.id, reason: "installation" }).message,
            }),
          ),
        );
        // A disconnected caller must not leave a running row without its installer fiber.
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.update(state, (tools) => [
              ...tools.filter((tool) => tool.id !== input.id),
              { ...plan.tool, phase: "running" as const, message: null },
            ]);
            yield* Effect.forkIn(restore(run), scope);
          }),
        );
      }),
    );
  });
  return SourceControlToolMaintenance.of({
    refresh,
    changes: Stream.unwrap(refresh.pipe(Effect.as(SubscriptionRef.changes(state)))),
    start,
  });
});

export const layer = Layer.effect(SourceControlToolMaintenance, make);
