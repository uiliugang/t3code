import {
  SourceControlToolError,
  type MeituanTool,
  type ServerSettings,
  type SourceControlTool,
  type SourceControlToolId,
  type SourceControlToolStartInput,
  type SkillSource,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as SourceControlToolInstaller from "./SourceControlToolInstaller.ts";
import * as Settings from "../serverSettings.ts";
import { SkillManager } from "../skills/SkillManager.ts";

export class SourceControlToolMaintenance extends Context.Service<
  SourceControlToolMaintenance,
  {
    readonly refresh: Effect.Effect<void>;
    readonly changes: Stream.Stream<ReadonlyArray<SourceControlTool>>;
    readonly meituanChanges: Stream.Stream<ReadonlyArray<MeituanTool>>;
    readonly start: (
      input: SourceControlToolStartInput,
    ) => Effect.Effect<void, SourceControlToolError>;
  }
>()("t3/sourceControl/SourceControlToolMaintenance") {}

class MeituanScanConfig extends Data.Class<{
  readonly requirements: boolean;
  readonly source: SkillSource | undefined;
}> {}

const make = Effect.gen(function* () {
  const installer = yield* SourceControlToolInstaller.SourceControlToolInstaller;
  const settings = yield* Settings.ServerSettingsService;
  const skills = yield* SkillManager;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const meituanLock = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<ReadonlyArray<SourceControlTool>>([]);
  const meituanState = yield* SubscriptionRef.make<ReadonlyArray<MeituanTool>>([]);
  const isActive = (tools: ReadonlyArray<SourceControlTool>) =>
    tools.some((tool) => tool.phase === "running" || tool.phase === "verifying");
  const update = (id: SourceControlToolId, patch: Partial<SourceControlTool>) =>
    SubscriptionRef.update(state, (tools) =>
      tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)),
    );
  let lastSettings = {
    meituanIntegrationEnabled: false,
    meituanRequirementsEnabled: false,
    meituanSourceControlEnabled: false,
  };
  const rememberSettings = ({
    meituanIntegrationEnabled,
    meituanRequirementsEnabled,
    meituanSourceControlEnabled,
  }: ServerSettings) =>
    (lastSettings = {
      meituanIntegrationEnabled,
      meituanRequirementsEnabled,
      meituanSourceControlEnabled,
    });
  const enabledSettings = settings.getSettings.pipe(
    Effect.map(rememberSettings),
    Effect.orElseSucceed(() => lastSettings),
  );
  const settingChanges = Stream.unwrap(
    settings.subscribeChanges.pipe(
      Effect.map((updates) =>
        Stream.fromEffect(enabledSettings).pipe(
          Stream.concat(updates.pipe(Stream.map(rememberSettings))),
        ),
      ),
    ),
  );
  const codeEnabled = settingChanges.pipe(
    Stream.map((saved) => SourceControlToolInstaller.isSourceControlToolEnabled("meituan", saved)),
    Stream.changes,
  );
  const meituanConfig = Stream.zipLatestWith(
    settingChanges,
    skills.meituanSource,
    (saved, source) =>
      new MeituanScanConfig({
        requirements: SourceControlToolInstaller.isMeituanToolEnabled("ones2", saved),
        source: saved.meituanIntegrationEnabled ? source : undefined,
      }),
  ).pipe(
    Stream.changesWith(
      (previous, next) =>
        previous.requirements === next.requirements && previous.source === next.source,
    ),
  );
  const inspectSourceTools = Effect.fn("SourceControlToolMaintenance.inspectSourceTools")(
    (
      enabled: boolean,
      previous: ReadonlyArray<SourceControlTool>,
      settledId?: SourceControlToolId,
    ) =>
      Effect.forEach(
        (["git", "github", "meituan"] as const).filter((id) => id !== "meituan" || enabled),
        (id) => {
          const old = previous.find((entry) => entry.id === id);
          if (id === settledId && old) return Effect.succeed(old);
          return installer.inspect(id).pipe(
            Effect.map(({ tool }) =>
              old ? { ...tool, phase: old.phase, message: old.message } : tool,
            ),
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
          );
        },
        { concurrency: 3 },
      ),
  );
  let sourceScanPending = false;
  let lastSourceScan: { enabled: boolean } | undefined;
  const publishSourceScan = Effect.fn("SourceControlToolMaintenance.publishSourceScan")(function* (
    enabled: boolean,
    previous: ReadonlyArray<SourceControlTool>,
    settledId?: SourceControlToolId,
  ) {
    const tools = yield* inspectSourceTools(enabled, previous, settledId);
    yield* SubscriptionRef.set(state, tools);
    lastSourceScan = { enabled };
  });
  const sourceScans = yield* Cache.make({
    capacity: 2,
    timeToLive: 0,
    lookup: (enabled: boolean) => {
      const observed = lastSourceScan;
      return lock.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* SubscriptionRef.get(state);
          if (isActive(previous)) {
            sourceScanPending = true;
            return;
          }
          if (observed !== lastSourceScan && lastSourceScan?.enabled === enabled) return;
          yield* publishSourceScan(enabled, previous);
        }),
      );
    },
  });

  const finish = Effect.fn("SourceControlToolMaintenance.finish")(function* (
    id: SourceControlToolId,
    patch: Partial<SourceControlTool>,
  ) {
    if (!sourceScanPending) return yield* update(id, patch);
    const previous = (yield* SubscriptionRef.get(state)).map((tool) =>
      tool.id === id ? { ...tool, ...patch } : tool,
    );
    const enabled = SourceControlToolInstaller.isSourceControlToolEnabled(
      "meituan",
      yield* enabledSettings,
    );
    yield* publishSourceScan(enabled, previous, id);
    sourceScanPending = false;
  }, lock.withPermits(1));
  const meituanScans = yield* Cache.make({
    capacity: 8,
    timeToLive: 0,
    lookup: ({ requirements, source }: MeituanScanConfig) =>
      meituanLock.withPermits(1)(
        Effect.gen(function* () {
          const meituanTools = yield* Effect.forEach(
            (["ones2", "mcm", "mtskills"] as const).filter((id) =>
              id === "mtskills" ? source !== undefined : requirements,
            ),
            (id) =>
              installer.inspectMeituan(id, id === "mtskills" ? source?.executable : undefined).pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    id,
                    label: SourceControlToolInstaller.meituanToolLabel(id),
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
          yield* SubscriptionRef.set(meituanState, meituanTools);
        }),
      ),
  });

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
          yield* finish(input.id, {
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
          Effect.catch((error) => finish(input.id, { phase: "failed", message: error.message })),
          Effect.onInterrupt(() =>
            update(input.id, {
              phase: "failed",
              message:
                "Installation was interrupted. Check the tool on the server before retrying.",
            }),
          ),
          Effect.catchCause(() =>
            finish(input.id, {
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
  const scanSourceControl = Effect.fn("SourceControlToolMaintenance.scanSourceControl")(
    (enabled: boolean) => Cache.get(sourceScans, enabled),
  );
  const scanMeituan = Effect.fn("SourceControlToolMaintenance.scanMeituan")(
    (config: MeituanScanConfig) => Cache.get(meituanScans, config),
  );
  const changes = codeEnabled.pipe(
    Stream.switchMap((enabled) =>
      Stream.unwrap(scanSourceControl(enabled).pipe(Effect.as(SubscriptionRef.changes(state)))),
    ),
  );
  const meituanChanges = meituanConfig.pipe(
    Stream.switchMap((config) =>
      Stream.unwrap(scanMeituan(config).pipe(Effect.as(SubscriptionRef.changes(meituanState)))),
    ),
  );
  return SourceControlToolMaintenance.of({
    refresh: Effect.all([Stream.runHead(changes), Stream.runHead(meituanChanges)], {
      concurrency: 2,
      discard: true,
    }),
    changes,
    meituanChanges,
    start,
  });
});

export const layer = Layer.effect(SourceControlToolMaintenance, make);
