import {
  SourceControlToolError,
  isRequirementCli,
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

const isMeituanMaintenanceTool = (id: string) => isRequirementCli(id) || id === "dumbo-web";

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
  readonly daxiangApproval: boolean;
  readonly source: SkillSource | undefined;
}> {
  includes(id: MeituanTool["id"]) {
    if (id === "mtskills") return this.source !== undefined;
    if (id === "dumbo-web") return this.daxiangApproval;
    return this.requirements;
  }
}

const make = Effect.gen(function* () {
  const installer = yield* SourceControlToolInstaller.SourceControlToolInstaller;
  const settings = yield* Settings.ServerSettingsService;
  const skills = yield* SkillManager;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const meituanLock = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<ReadonlyArray<SourceControlTool>>([]);
  const meituanState = yield* SubscriptionRef.make<ReadonlyArray<MeituanTool>>([]);
  const isActive = (tool: Pick<SourceControlTool, "phase">) =>
    tool.phase === "running" || tool.phase === "verifying";
  const update = (
    id: SourceControlToolId,
    patch: Partial<SourceControlTool>,
    verified?: SourceControlTool | MeituanTool,
  ) =>
    isMeituanMaintenanceTool(id)
      ? SubscriptionRef.update(meituanState, (tools) =>
          tools.map((tool) => (tool.id === id ? { ...(verified ?? tool), ...patch, id } : tool)),
        )
      : SubscriptionRef.update(state, (tools) =>
          tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)),
        );
  let lastSettings = {
    meituanIntegrationEnabled: false,
    meituanRequirementsEnabled: false,
    meituanSourceControlEnabled: false,
    daxiang: { approvalMonitor: { enabled: false } },
  };
  const rememberSettings = ({
    meituanIntegrationEnabled,
    meituanRequirementsEnabled,
    meituanSourceControlEnabled,
    daxiang,
  }: ServerSettings) =>
    (lastSettings = {
      meituanIntegrationEnabled,
      meituanRequirementsEnabled,
      meituanSourceControlEnabled,
      daxiang: { approvalMonitor: { enabled: daxiang.approvalMonitor.enabled } },
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
        daxiangApproval: SourceControlToolInstaller.isMeituanToolEnabled("dumbo-web", saved),
        source: saved.meituanIntegrationEnabled ? source : undefined,
      }),
  ).pipe(
    Stream.changesWith(
      (previous, next) =>
        previous.requirements === next.requirements &&
        previous.daxiangApproval === next.daxiangApproval &&
        previous.source === next.source,
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
          if (previous.some(isActive)) {
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
    result: Pick<SourceControlTool, "phase" | "message">,
    verified?: SourceControlTool | MeituanTool,
  ) {
    if (isMeituanMaintenanceTool(id))
      return yield* meituanLock.withPermits(1)(update(id, result, verified));
    const patch = { ...verified, ...result, id };
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
    capacity: 16,
    timeToLive: 0,
    lookup: (config: MeituanScanConfig) =>
      meituanLock.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* SubscriptionRef.get(meituanState);
          const meituanTools = yield* Effect.forEach(
            (["ones2", "mcm", "mtskills", "dumbo-web"] as const).filter((id) =>
              config.includes(id),
            ),
            (id) => {
              const active = previous.find((tool) => tool.id === id && isActive(tool));
              if (active) return Effect.succeed(active);
              return installer
                .inspectMeituan(id, id === "mtskills" ? config.source?.executable : undefined)
                .pipe(
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
                );
            },
            { concurrency: 3 },
          );
          yield* SubscriptionRef.update(meituanState, (current) => [
            ...current.filter((tool) => !config.includes(tool.id)),
            ...meituanTools.map((tool) => {
              const old = current.find((entry) => entry.id === tool.id);
              return old ? { ...tool, phase: old.phase, message: old.message } : tool;
            }),
          ]);
        }),
      ),
  });

  const start = Effect.fn("SourceControlToolMaintenance.start")(function* (
    input: SourceControlToolStartInput,
  ) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (
          (yield* SubscriptionRef.get(meituanState)).some(isActive) ||
          (yield* SubscriptionRef.get(state)).some(isActive)
        )
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
          // A confirmed installation still needs verification if its settings row is hidden.
          const verified = isRequirementCli(input.id)
            ? yield* installer.verifyRequirementCli(input.id)
            : (yield* installer.inspect(input.id)).tool;
          if (
            verified.version === null ||
            verified.executablePath === null ||
            (plan.tool.executablePath !== null &&
              plan.tool.executablePath !== verified.executablePath) ||
            (plan.tool.version !== null &&
              compareSemverVersions(verified.version, plan.tool.version) < 0)
          )
            return yield* new SourceControlToolError({ id: input.id, reason: "verification" });
          const unchanged = plan.tool.version === verified.version;
          yield* finish(
            input.id,
            {
              phase: unchanged ? "unchanged" : "succeeded",
              message:
                outcome === "current"
                  ? "Already up to date."
                  : unchanged
                    ? "The version is unchanged. Check the package manager's available version on the server."
                    : "Installation verified.",
            },
            verified,
          );
        }).pipe(
          Effect.catch((error) => finish(input.id, { phase: "failed", message: error.message })),
          Effect.onInterrupt(() =>
            finish(input.id, {
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
            const id = input.id;
            const running = { ...plan.tool, phase: "running" as const, message: null };
            if (isMeituanMaintenanceTool(id)) {
              yield* meituanLock.withPermits(1)(
                SubscriptionRef.update(meituanState, (tools) => [
                  ...tools.filter((tool) => tool.id !== id),
                  { ...tools.find((tool) => tool.id === id), ...running, id },
                ]),
              );
            } else {
              yield* SubscriptionRef.update(state, (tools) => [
                ...tools.filter((tool) => tool.id !== id),
                running,
              ]);
            }
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
      Stream.unwrap(
        scanMeituan(config).pipe(Effect.as(SubscriptionRef.changes(meituanState))),
      ).pipe(Stream.map((tools) => tools.filter((tool) => config.includes(tool.id)))),
    ),
  );
  return SourceControlToolMaintenance.of({
    refresh: Effect.all([Stream.runHead(changes), Stream.runHead(meituanChanges)], {
      concurrency: 2,
      discard: true,
    }),
    changes,
    // Older clients can only copy commands for ONES and MCM.
    meituanChanges: meituanChanges.pipe(
      Stream.map((tools) =>
        tools.map((tool) =>
          isMeituanMaintenanceTool(tool.id) && tool.command
            ? {
                ...tool,
                maintenanceCommand: tool.command,
                command: null,
              }
            : tool,
        ),
      ),
    ),
    start,
  });
});

export const layer = Layer.effect(SourceControlToolMaintenance, make);
