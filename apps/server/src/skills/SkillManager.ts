import * as Crypto from "effect/Crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's symlink API cannot request Windows directory junctions.
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import {
  SkillCatalog,
  skillFailureMessage,
  SkillAction,
  type SkillJob,
  type SkillInspect,
  type SkillInspection,
  type DiscoveredSkill,
  SkillManagerError,
  type ManagedSkill,
  type SkillMutation,
  type SkillSnapshot,
  type SkillTarget,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { makeSkillDiscovery } from "./SkillDiscovery.ts";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as SkillPackages from "./SkillPackages.ts";
import * as SkillHost from "./SkillHost.ts";

const actionKey = Schema.encodeSync(Schema.fromJsonString(SkillAction));
const codec = Schema.fromJsonString(SkillCatalog);
const decode = Schema.decodeUnknownEffect(codec);
const encode = Schema.encodeEffect(codec);
const isSkillManagerError = Schema.is(SkillManagerError);
const initial: SkillCatalog = {
  lastFailure: null,
  skills: [],
  customTargets: [],
  sources: [
    {
      id: "local",
      label: "Local import",
      kind: "local",
      enabled: true,
      executable: "",
      registry: "",
    },
    {
      id: "community",
      label: "Git / HTTP",
      kind: "skills",
      enabled: true,
      executable: "",
      registry: "https://registry.npmjs.org",
    },
    {
      id: "meituan",
      label: "Meituan Skills",
      kind: "mtskills",
      enabled: false,
      executable: "mtskills",
      registry: "http://r.npm.sankuai.com",
    },
  ],
};
export class SkillManager extends Context.Service<
  SkillManager,
  {
    readonly mutate: (input: SkillMutation) => Effect.Effect<void, SkillManagerError>;
    readonly inspect: (input: SkillInspect) => Effect.Effect<SkillInspection, SkillManagerError>;
    readonly tick: Effect.Effect<void>;
    readonly snapshot: Effect.Effect<SkillSnapshot, SkillManagerError>;
    readonly changes: Stream.Stream<SkillSnapshot, SkillManagerError>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/skills/SkillManager") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const packages = yield* SkillPackages.SkillPackages;
  const host = yield* SkillHost.SkillHost;
  const discovery = yield* makeSkillDiscovery;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const directoryLink = Effect.fn("SkillManager.directoryLink")(function* (
    target: string,
    link: string,
  ) {
    if (platform === "win32") {
      yield* Effect.tryPromise({
        try: () => NodeFSP.symlink(target, link, "junction"),
        catch: (cause) => new SkillManagerError({ operation: "link", reason: "io", cause }),
      });
    } else yield* fs.symlink(target, link);
  });
  const root = path.join(config.stateDir, "skills");
  const stored = yield* sql<{ payload: string }>`SELECT payload FROM skill_catalog WHERE id = 1`;
  const state = yield* Ref.make(stored[0] ? yield* decode(stored[0].payload) : initial);
  const revision = yield* SubscriptionRef.make(0);
  const writeLock = yield* Semaphore.make(1);
  const jobLock = yield* Semaphore.make(1);
  const runningJob = yield* Ref.make<string | null>(null);
  const discoveries = yield* Ref.make<ReadonlyArray<DiscoveredSkill>>([]);
  const scannedAt = yield* Ref.make<string | undefined>(undefined);
  const operation = yield* Ref.make<string | null>(null);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const persist = Effect.fn("SkillManager.persist")(function* (next: SkillCatalog) {
    const payload = yield* encode(next);
    yield* sql`INSERT INTO skill_catalog (id, payload) VALUES (1, ${payload}) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`;
    yield* Ref.set(state, next);
    yield* SubscriptionRef.update(revision, (n) => n + 1);
  });
  const save = Effect.fn("SkillManager.save")(function* (next: SkillCatalog) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        yield* persist({ ...next, jobs: (yield* Ref.get(state)).jobs ?? [] });
      }),
    );
  });
  const saveJobs = Effect.fn("SkillManager.saveJobs")(function* (
    update: (jobs: ReadonlyArray<SkillJob>) => ReadonlyArray<SkillJob>,
  ) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const jobs = update(current.jobs ?? []);
        const pending = jobs.filter((job) => job.status === "queued" || job.status === "running");
        yield* persist({
          ...current,
          jobs: [
            ...jobs
              .filter((job) => job.status !== "queued" && job.status !== "running")
              .slice(-100),
            ...pending,
          ],
        });
      }),
    );
  });
  const replace = Effect.fn("SkillManager.replace")(function* (skill: ManagedSkill) {
    const current = yield* Ref.get(state);
    yield* save({
      ...current,
      skills: current.skills.some((entry) => entry.id === skill.id)
        ? current.skills.map((entry) => (entry.id === skill.id ? skill : entry))
        : [...current.skills, skill],
    });
  });
  const get = Effect.fn("SkillManager.get")(function* (id: string) {
    const skill = (yield* Ref.get(state)).skills.find((entry) => entry.id === id);
    if (!skill) return yield* new SkillManagerError({ operation: "read", reason: "not-found" });
    return skill;
  });
  const allTargets = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const targets = new Map((yield* host.targets).map((target) => [target.id, target]));
    for (const target of current.customTargets) targets.set(target.id, target);
    return [...targets.values()];
  });
  const selectedTargets = Effect.fn("SkillManager.selectedTargets")(function* (
    ids: ReadonlyArray<string>,
  ) {
    const targets = yield* allTargets;
    const selected: SkillTarget[] = [];
    for (const id of new Set(ids)) {
      const target = targets.find((entry) => entry.id === id);
      if (!target)
        return yield* new SkillManagerError({ operation: "target", reason: "not-found" });
      const real = yield* fs
        .realPath(target.directory)
        .pipe(Effect.orElseSucceed(() => path.resolve(target.directory)));
      if (
        !(yield* Effect.forEach(selected, (entry) =>
          fs
            .realPath(entry.directory)
            .pipe(Effect.orElseSucceed(() => path.resolve(entry.directory))),
        )).includes(real)
      )
        selected.push(target);
    }
    return selected;
  });
  const activePath = (id: string) => path.join(root, "active", id);
  const versionPath = (id: string, digest: string) => path.join(root, "versions", id, digest);
  const baselinePath = (id: string, digest: string) => path.join(root, "baselines", id, digest);
  const packagePath = Effect.fn("SkillManager.packagePath")(function* (id: string, digest: string) {
    const baseline = baselinePath(id, digest);
    return (yield* fs.exists(baseline)) ? baseline : versionPath(id, digest);
  });
  const linkPath = (skill: ManagedSkill, target: SkillTarget & { readonly entryName?: string }) =>
    path.join(target.directory, target.entryName ?? skill.name);
  const readLink = Effect.fn("SkillManager.readLink")(function* (file: string) {
    return yield* fs.readLink(file).pipe(
      Effect.map((target) => path.resolve(path.dirname(file), target)),
      Effect.catchTags({
        PlatformError: (error) => {
          const cause = error.reason.cause;
          const notLink =
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "EINVAL";
          return error.reason._tag === "NotFound" || notLink
            ? Effect.succeed(null)
            : Effect.fail(error);
        },
      }),
    );
  });
  const filePresent = Effect.fn("SkillManager.filePresent")(function* (file: string) {
    return (yield* readLink(file)) !== null || (yield* fs.exists(file));
  });
  const detach = Effect.fn("SkillManager.detach")(function* (
    skill: ManagedSkill,
    target: SkillTarget,
  ) {
    const file = linkPath(skill, target);
    if ((yield* readLink(file)) === activePath(skill.id)) yield* fs.remove(file);
    else if (yield* filePresent(file))
      return yield* new SkillManagerError({ operation: "detach", reason: "conflict" });
  });
  const syncBindings = Effect.fn("SkillManager.syncBindings")(function* (skill: ManagedSkill) {
    const bindings: Array<ManagedSkill["bindings"][number]> = [];
    for (const target of skill.bindings) {
      const file = linkPath(skill, target);
      const result = yield* Effect.gen(function* () {
        yield* fs.makeDirectory(target.directory, { recursive: true });
        if ((yield* readLink(file)) === activePath(skill.id)) return "linked" as const;
        if (yield* filePresent(file)) return "conflict" as const;
        yield* directoryLink(activePath(skill.id), file);
        return "linked" as const;
      }).pipe(Effect.result);
      bindings.push({ ...target, status: result._tag === "Success" ? result.success : "missing" });
    }
    return { ...skill, bindings };
  });
  const switchActive = Effect.fn("SkillManager.switchActive")(function* (skill: ManagedSkill) {
    if (!skill.activeDigest) return skill;
    const link = activePath(skill.id);
    const expected = skill.workKey
      ? path.join(root, "working", skill.id, skill.workKey)
      : versionPath(skill.id, skill.activeDigest);
    if (!(yield* fs.exists(path.join(expected, "SKILL.md"))))
      return yield* new SkillManagerError({ operation: "activate", reason: "not-found" });
    yield* fs.makeDirectory(path.dirname(link), { recursive: true });
    const existing = yield* readLink(link);
    if (existing !== expected) {
      if (existing === null && (yield* fs.exists(link)))
        return yield* new SkillManagerError({ operation: "activate", reason: "conflict" });
      const temporary = `${link}.next`;
      if (yield* filePresent(temporary)) yield* fs.remove(temporary);
      yield* directoryLink(expected, temporary);
      if (platform === "win32" && existing !== null) yield* fs.remove(link);
      yield* fs.rename(temporary, link);
    }
    return yield* syncBindings(skill);
  });
  const refreshDiscovery = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const managed = new Set(
      current.skills.flatMap((skill) =>
        skill.bindings.map((target) => path.join(linkPath(skill, target), "SKILL.md")),
      ),
    );
    yield* Ref.set(
      discoveries,
      yield* discovery.scan(yield* allTargets, yield* host.discovered, root, managed),
    );
    yield* Ref.set(scannedAt, yield* now);
    yield* SubscriptionRef.update(revision, (n) => n + 1);
  });
  const inspect = Effect.fn("SkillManager.inspect")(
    function* (input: SkillInspect) {
      if (input.type === "adopt") {
        const description = yield* discovery.describe(input.path);
        const data = yield* packages.inspect(description.identity);
        return {
          name: data.name,
          description: data.description,
          digest: data.digest,
          candidateDigest: null,
          ...(description.origin ? { origin: description.origin } : {}),
          external: description.external,
          files: data.files.map((file) => ({
            path: file.path,
            status: "unchanged" as const,
            before: file.text,
            after: file.text,
          })),
          truncated: data.truncated,
        };
      }
      const skill = yield* get(input.id);
      const current = skill.activeDigest
        ? yield* packages.inspect(activePath(skill.id))
        : undefined;
      const candidateDigest =
        skill.availableDigest ??
        (current && current.digest !== skill.activeDigest ? skill.activeDigest : null);
      const candidate = candidateDigest
        ? yield* packages.inspect(yield* packagePath(skill.id, candidateDigest))
        : undefined;
      const before = new Map(current?.files.map((file) => [file.path, file]) ?? []);
      const after = new Map(
        candidate?.files.map((file) => [file.path, file]) ??
          current?.files.map((file) => [file.path, file]) ??
          [],
      );
      return {
        name: skill.name,
        description: skill.description,
        digest: current?.digest ?? candidate?.digest ?? skill.id,
        candidateDigest,
        external: false,
        truncated: Boolean(current?.truncated || candidate?.truncated),
        files: [...new Set([...before.keys(), ...after.keys()])].toSorted().map((file) => ({
          path: file,
          status: !before.has(file)
            ? ("added" as const)
            : !after.has(file)
              ? ("removed" as const)
              : before.get(file)?.hash !== after.get(file)?.hash
                ? ("changed" as const)
                : ("unchanged" as const),
          before: before.get(file)?.text ?? "",
          after: after.get(file)?.text ?? "",
        })),
      };
    },
    Effect.mapError((cause) =>
      isSkillManagerError(cause)
        ? cause
        : new SkillManagerError({ operation: "inspect", reason: "io", cause }),
    ),
  );
  const assertUnmodified = Effect.fn("SkillManager.assertUnmodified")(function* (
    skill: ManagedSkill,
  ) {
    if (!skill.activeDigest) return;
    const actual = yield* packages.inspect(activePath(skill.id));
    if (actual.digest !== skill.activeDigest)
      return yield* new SkillManagerError({ operation: "activate", reason: "local-changes" });
  });
  const activate = Effect.fn("SkillManager.activate")(function* (
    skill: ManagedSkill,
    digest: string,
    allowModified = false,
  ) {
    const jobId = yield* Ref.get(runningJob);
    const cancelled = (yield* Ref.get(state)).jobs?.some(
      (job) => job.id === jobId && job.status === "cancelled",
    );
    if (cancelled || (!allowModified && skill.cancelledDigest === digest)) {
      yield* replace({
        ...skill,
        status: "ready",
        cancelledDigest: digest,
        availableDigest: digest,
      });
      return;
    }
    if (!allowModified) yield* assertUnmodified(skill);
    const candidate = yield* packages.inspect(yield* packagePath(skill.id, digest));
    if (candidate.digest !== digest)
      return yield* new SkillManagerError({ operation: "activate", reason: "candidate-changed" });
    if (skill.activeDigest)
      for (const target of skill.bindings) {
        const file = linkPath(skill, target);
        if ((yield* filePresent(file)) && (yield* readLink(file)) !== activePath(skill.id))
          return yield* new SkillManagerError({ operation: "activate", reason: "conflict" });
      }
    if (yield* host.busy) {
      yield* replace({
        ...skill,
        availableDigest: digest,
        status: "pending",
        phase: "waiting",
        failure: null,
        failureReason: null,
      });
      return;
    }
    if (allowModified && skill.activeDigest) {
      const current = yield* packages.inspect(activePath(skill.id));
      if (current.digest !== skill.activeDigest) {
        const preserved = baselinePath(skill.id, current.digest);
        if (!(yield* fs.exists(preserved))) yield* packages.inspect(current.directory, preserved);
        skill = {
          ...skill,
          versions: [
            ...skill.versions.filter((version) => version.digest !== current.digest),
            { digest: current.digest, createdAt: yield* now },
          ],
        };
      }
    }
    const workKey = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    yield* packages.inspect(candidate.directory, path.join(root, "working", skill.id, workKey));
    const linked = yield* jobLock.withPermits(1)(
      Effect.gen(function* () {
        if (
          (yield* Ref.get(state)).jobs?.some(
            (job) => job.id === jobId && job.status === "cancelled",
          )
        ) {
          yield* replace({
            ...skill,
            status: "ready",
            cancelledDigest: digest,
            availableDigest: digest,
          });
          return null;
        }
        // Persist the desired version first so recovery can complete an interrupted link switch.
        const desired: ManagedSkill = {
          ...skill,
          pendingActivation: { digest, workKey },
          availableDigest: digest,
          status: "pending",
          phase: "applying",
          failure: null,
          failureReason: null,
        };
        yield* replace(desired);
        const { pendingActivation: _pending, ...committed } = desired;
        const linked = yield* switchActive({
          ...committed,
          activeDigest: digest,
          workKey,
          availableDigest: null,
        });
        const failed = linked.bindings.some((target) => target.status !== "linked");
        yield* replace({
          ...linked,
          status: failed ? "failed" : "ready",
          phase: "prepared",
          failureReason: failed ? "conflict" : skill.snapshotOnly ? "needs-source" : null,
          failure: failed
            ? "Some targets could not be linked. Resolve conflicts and retry the bindings."
            : null,
        });
        const finishedAt = yield* now;
        yield* saveJobs((jobs) =>
          jobs.map((job) =>
            job.id === jobId
              ? {
                  ...job,
                  status: failed ? "failed" : "completed",
                  reason: failed ? "conflict" : null,
                  finishedAt,
                }
              : job,
          ),
        );
        return linked;
      }),
    );
    if (!linked) return;
    const failed = linked.bindings.some((target) => target.status !== "linked");
    yield* host.refresh(linked.bindings);
    const finishedAt = yield* now;
    yield* saveJobs((jobs) =>
      jobs.map((job) =>
        job.skillId === skill.id && job.status === "waiting"
          ? {
              ...job,
              status: failed ? "failed" : "completed",
              reason: failed ? "conflict" : null,
              finishedAt,
            }
          : job,
      ),
    );
  });
  const fetchVersion = Effect.fn("SkillManager.fetchVersion")(function* (
    skill: ManagedSkill,
    apply: boolean,
  ) {
    if (skill.snapshotOnly)
      return yield* new SkillManagerError({ operation: "fetch", reason: "needs-source" });
    const source = (yield* Ref.get(state)).sources.find((entry) => entry.id === skill.sourceId);
    if (!source) return yield* new SkillManagerError({ operation: "fetch", reason: "not-found" });
    yield* replace({
      ...skill,
      status: "fetching",
      phase: "downloading",
      failureReason: null,
      failure: null,
      checkedAt: yield* now,
    });
    const staging = path.join(root, "staging", yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    yield* Effect.gen(function* () {
      const fetched = yield* packages.fetch({
        source,
        locator: skill.locator,
        skill: skill.requestedSkill,
        staging,
      });
      if (skill.activeDigest && fetched.name !== skill.name)
        return yield* new SkillManagerError({ operation: "update", reason: "invalid-package" });
      const destination = versionPath(skill.id, fetched.digest);
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      const baseline = baselinePath(skill.id, fetched.digest);
      if (!(yield* fs.exists(baseline))) yield* packages.inspect(fetched.directory, baseline);
      if (!(yield* fs.exists(destination))) yield* fs.rename(fetched.directory, destination);
      const date = yield* now;
      const next: ManagedSkill = {
        ...skill,
        name: fetched.name,
        description: fetched.description,
        checkedAt: date,
        status: "ready",
        phase: "prepared",
        failure: null,
        failureReason: null,
        availableDigest: fetched.digest === skill.activeDigest ? null : fetched.digest,
        versions: skill.versions.some((version) => version.digest === fetched.digest)
          ? skill.versions
          : [
              ...skill.versions,
              {
                digest: fetched.digest,
                createdAt: date,
                ...(fetched.version ? { label: fetched.version } : {}),
              },
            ],
      };
      yield* replace(next);
      yield* assertUnmodified(next);
      if (apply && (fetched.digest !== skill.activeDigest || skill.status === "pending"))
        yield* activate(next, fetched.digest);
    }).pipe(
      Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  });
  const remove = Effect.fn("SkillManager.remove")(function* (skill: ManagedSkill) {
    if (yield* host.busy)
      return yield* new SkillManagerError({ operation: "remove", reason: "busy" });
    if (skill.status !== "removing") yield* assertUnmodified(skill);
    yield* replace({ ...skill, status: "removing" });
    for (const target of skill.bindings) yield* detach(skill, target);
    yield* restoreBackups(skill);
    if (yield* filePresent(activePath(skill.id))) yield* fs.remove(activePath(skill.id));
    yield* fs.remove(path.join(root, "versions", skill.id), { recursive: true, force: true });
    yield* fs.remove(path.join(root, "baselines", skill.id), { recursive: true, force: true });
    yield* fs.remove(path.join(root, "working", skill.id), { recursive: true, force: true });
    const current = yield* Ref.get(state);
    yield* save({ ...current, skills: current.skills.filter((entry) => entry.id !== skill.id) });
    yield* host.refresh(skill.bindings);
  });
  const restoreBackups = Effect.fn("SkillManager.restoreBackups")(function* (skill: ManagedSkill) {
    for (const entry of skill.backups ?? []) {
      if (!(yield* filePresent(entry.backup))) continue;
      if ((yield* readLink(entry.original)) === activePath(skill.id))
        yield* fs.remove(entry.original);
      if (yield* filePresent(entry.original))
        return yield* new SkillManagerError({ operation: "restore", reason: "conflict" });
      yield* fs.rename(entry.backup, entry.original);
    }
  });
  const unmanage = Effect.fn("SkillManager.unmanage")(function* (
    skill: ManagedSkill,
    restore: boolean,
  ) {
    if (yield* host.busy)
      return yield* new SkillManagerError({ operation: "unmanage", reason: "busy" });
    restore = skill.pendingUnmanage?.restore ?? restore;
    const digest =
      skill.pendingUnmanage?.digest ?? (yield* packages.inspect(activePath(skill.id))).digest;
    skill = { ...skill, pendingUnmanage: { restore, digest } };
    yield* replace(skill);
    for (const target of skill.bindings) {
      const file = linkPath(skill, target);
      const existing = yield* readLink(file);
      if (existing !== activePath(skill.id) && (yield* filePresent(file))) {
        const backup = skill.backups?.find((entry) => entry.original === file);
        if (restore && backup && !(yield* filePresent(backup.backup))) continue;
        if ((yield* packages.inspect(file)).digest !== digest)
          return yield* new SkillManagerError({ operation: "unmanage", reason: "conflict" });
      }
    }
    for (const target of skill.bindings) {
      const file = linkPath(skill, target);
      if (restore && skill.backups?.some((entry) => entry.original === file)) continue;
      if ((yield* filePresent(file)) && (yield* readLink(file)) !== activePath(skill.id)) continue;
      if (skill.activeDigest) {
        const temporary = `${file}.t3-preserve-${skill.id}`;
        yield* fs.remove(temporary, { recursive: true, force: true });
        yield* fs.copy(yield* fs.realPath(activePath(skill.id)), temporary);
        if ((yield* readLink(file)) === activePath(skill.id)) yield* fs.remove(file);
        yield* fs.rename(temporary, file);
      }
    }
    if (restore) yield* restoreBackups(skill);
    // Unassigned library versions and original backups remain available after management ends.
    const current = yield* Ref.get(state);
    yield* save({ ...current, skills: current.skills.filter((entry) => entry.id !== skill.id) });
    if (yield* filePresent(activePath(skill.id))) yield* fs.remove(activePath(skill.id));
    yield* host.refresh(skill.bindings);
  });
  const abortAdoption = Effect.fn("SkillManager.abortAdoption")(function* (skill: ManagedSkill) {
    yield* restoreBackups(skill);
    const current = yield* Ref.get(state);
    yield* save({ ...current, skills: current.skills.filter((entry) => entry.id !== skill.id) });
  });
  const adopt = Effect.fn("SkillManager.adopt")(function* (
    input: Extract<SkillAction, { type: "adopt" }>,
  ) {
    const description = yield* discovery.describe(input.path);
    if (description.external)
      return yield* new SkillManagerError({ operation: "adopt", reason: "external" });
    const current = yield* Ref.get(state);
    if (current.skills.some((skill) => skill.adoptedFrom === description.identity))
      return yield* new SkillManagerError({ operation: "adopt", reason: "conflict" });
    if (input.mode === "takeover" && (yield* host.busy))
      return yield* new SkillManagerError({ operation: "adopt", reason: "busy" });
    const data = yield* packages.inspect(description.identity);
    if (data.digest !== input.digest)
      return yield* new SkillManagerError({ operation: "adopt", reason: "candidate-changed" });
    const id = (yield* Ref.get(runningJob)) ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const targets = yield* selectedTargets(input.targetIds);
    const requestedOrigin = input.origin ?? description.origin;
    const source = current.sources.find(
      (entry) => entry.id === (requestedOrigin?.sourceId ?? "local"),
    );
    if (!source) return yield* new SkillManagerError({ operation: "adopt", reason: "not-found" });
    const backups: Array<{ original: string; backup: string }> = [];
    const bindings: Array<ManagedSkill["bindings"][number]> = [];
    for (const target of targets) {
      const discovered = (yield* Ref.get(discoveries)).find(
        (entry) => entry.identity === description.identity,
      );
      const originalPath = discovered?.paths?.find(
        (file) => path.dirname(path.dirname(file)) === target.directory,
      );
      const entryName = originalPath ? path.basename(path.dirname(originalPath)) : data.name;
      const file = path.join(target.directory, entryName);
      if (yield* filePresent(file)) {
        if (input.mode !== "takeover" || (yield* fs.realPath(file)) !== description.identity)
          return yield* new SkillManagerError({ operation: "adopt", reason: "conflict" });
        backups.push({
          original: file,
          backup: path.join(root, "backups", id, String(backups.length)),
        });
      }
      bindings.push({ ...target, entryName, status: "missing" });
    }
    const locator = requestedOrigin?.locator ?? description.identity;
    const localSource =
      source.kind === "local"
        ? yield* fs.realPath(locator).pipe(Effect.orElseSucceed(() => locator))
        : null;
    const snapshotOnly =
      input.mode === "takeover" &&
      localSource !== null &&
      (localSource === description.identity || localSource.startsWith(root + path.sep));
    yield* packages.inspect(description.identity, versionPath(id, data.digest));
    yield* packages.inspect(description.identity, baselinePath(id, data.digest));
    const skill: ManagedSkill = {
      id,
      name: data.name,
      description: data.description,
      sourceId: source.id,
      sourceLabel: source.label,
      locator,
      requestedSkill: requestedOrigin?.skill ?? "",
      activeDigest: null,
      availableDigest: data.digest,
      versions: [
        {
          digest: data.digest,
          createdAt: yield* now,
          ...(data.version ? { label: data.version } : {}),
        },
      ],
      bindings,
      policy: input.policy ?? "automatic",
      policyOrigin: input.policy ? "explicit" : "default",
      status: "pending",
      failure: null,
      failureReason: snapshotOnly ? "needs-source" : null,
      checkedAt: yield* now,
      snapshotOnly,
      adoptedFrom: description.identity,
      backups,
      adoptionState: "preparing",
    };
    yield* replace(skill);
    yield* Effect.gen(function* () {
      for (const entry of backups) {
        yield* fs.makeDirectory(path.dirname(entry.backup), { recursive: true });
        yield* fs.rename(entry.original, entry.backup);
      }
      yield* activate(skill, data.digest);
      yield* replace({ ...(yield* get(id)), adoptionState: "complete" });
    }).pipe(Effect.tapError(() => abortAdoption(skill)));
  });
  const execute = Effect.fn("SkillManager.execute")(function* (input: SkillAction) {
    const current = yield* Ref.get(state);
    yield* save({ ...current, lastFailure: null, lastFailureReason: null });
    switch (input.type) {
      case "refresh":
        yield* refreshDiscovery;
        return;
      case "source.check": {
        const source = current.sources.find((entry) => entry.id === input.sourceId);
        if (!source)
          return yield* new SkillManagerError({ operation: "source.check", reason: "not-found" });
        const result = yield* packages.diagnose(source).pipe(Effect.result);
        const health = {
          checkedAt: yield* now,
          reason: result._tag === "Failure" ? result.failure.reason : null,
          detail:
            result._tag === "Failure"
              ? result.failure.message
              : source.kind === "local"
                ? "Local storage is available."
                : "Installer is available. Authentication and package access are checked during download.",
        };
        yield* save({
          ...current,
          sources: current.sources.map((entry) =>
            entry.id === source.id ? { ...entry, health } : entry,
          ),
        });
        if (result._tag === "Failure") return yield* result.failure;
        return;
      }
      case "source.prepare": {
        const source = current.sources.find((entry) => entry.id === input.sourceId);
        if (!source)
          return yield* new SkillManagerError({ operation: "prepare", reason: "not-found" });
        const executable = yield* packages.prepare(source);
        yield* save({
          ...current,
          lastFailure: null,
          sources: current.sources.map((entry) =>
            entry.id === source.id ? { ...entry, executable } : entry,
          ),
        });
        return;
      }
      case "source.remove": {
        if (current.skills.some((skill) => skill.sourceId === input.sourceId))
          return yield* new SkillManagerError({ operation: "source", reason: "conflict" });
        yield* save({
          ...current,
          lastFailure: null,
          sources: current.sources.filter((source) => source.id !== input.sourceId),
        });
        return;
      }
      case "target.remove": {
        if (
          current.skills.some((skill) =>
            skill.bindings.some((target) => target.id === input.targetId),
          )
        )
          return yield* new SkillManagerError({ operation: "target", reason: "conflict" });
        yield* save({
          ...current,
          lastFailure: null,
          customTargets: current.customTargets.filter((target) => target.id !== input.targetId),
        });
        return;
      }
      case "source.save": {
        if (input.source.registry && !/^https?:\/\//.test(input.source.registry))
          return yield* new SkillManagerError({ operation: "source", reason: "invalid-package" });
        const existing = current.sources.find((source) => source.id === input.source.id);
        if (
          existing &&
          existing.kind !== input.source.kind &&
          current.skills.some((skill) => skill.sourceId === existing.id)
        )
          return yield* new SkillManagerError({ operation: "source", reason: "conflict" });
        yield* save({
          ...current,
          lastFailure: null,
          sources: [
            ...current.sources.filter((source) => source.id !== input.source.id),
            input.source,
          ],
        });
        return;
      }
      case "target.save": {
        if (!path.isAbsolute(input.target.directory))
          return yield* new SkillManagerError({ operation: "target", reason: "invalid-package" });
        if (
          current.skills.some((skill) =>
            skill.bindings.some(
              (binding) =>
                binding.id === input.target.id && binding.directory !== input.target.directory,
            ),
          )
        )
          return yield* new SkillManagerError({ operation: "target", reason: "conflict" });
        yield* save({
          ...current,
          lastFailure: null,
          customTargets: [
            ...current.customTargets.filter((target) => target.id !== input.target.id),
            input.target,
          ],
        });
        return;
      }
      case "adopt":
        yield* adopt(input);
        return;
      case "install": {
        const source = current.sources.find((entry) => entry.id === input.sourceId);
        if (!source)
          return yield* new SkillManagerError({ operation: "install", reason: "not-found" });
        if (!source.enabled)
          return yield* new SkillManagerError({ operation: "install", reason: "source-disabled" });
        const existing = current.skills.find(
          (entry) =>
            entry.sourceId === source.id &&
            entry.locator === input.locator &&
            entry.requestedSkill === input.skill,
        );
        if (existing)
          return yield* new SkillManagerError({ operation: "install", reason: "conflict" });
        const targets = yield* selectedTargets(input.targetIds);
        const id =
          (yield* Ref.get(runningJob)) ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        const sourceLabel =
          source.id === "community" &&
          (/^https:\/\/github\.com\//.test(input.locator) ||
            /^[\w.-]+\/[\w.-]+(?:@.*)?$/.test(input.locator))
            ? "GitHub"
            : source.label;
        const skill: ManagedSkill = {
          id,
          name: id,
          description: "",
          sourceId: source.id,
          sourceLabel,
          locator: input.locator,
          requestedSkill: input.skill,
          versions: [],
          activeDigest: null,
          availableDigest: null,
          bindings: targets.map((target) => ({ ...target, status: "missing" })),
          policy: input.policy ?? "automatic",
          policyOrigin: input.policy ? "explicit" : "default",
          status: "fetching",
          failure: null,
          checkedAt: null,
        };
        yield* replace(skill);
        yield* fetchVersion(skill, true);
        return;
      }
      default: {
        const skill = yield* get(input.id);
        const runningJobValue = yield* Ref.get(runningJob);
        switch (input.type) {
          case "cancel":
            yield* replace({
              ...skill,
              status: "ready",
              phase: "prepared",
              cancelledDigest: skill.availableDigest,
              failure: null,
              failureReason: null,
            });
            break;
          case "policy":
            yield* replace({
              ...skill,
              policy: input.policy,
              policyOrigin: "explicit",
              cancelledDigest: null,
              status:
                input.policy !== "automatic" && skill.status === "pending" ? "ready" : skill.status,
            });
            if (input.policy !== "automatic") {
              const finishedAt = yield* now;
              yield* saveJobs((jobs) =>
                jobs.map((job) =>
                  job.skillId === skill.id && job.status === "waiting"
                    ? { ...job, status: "cancelled", finishedAt }
                    : job,
                ),
              );
            }
            break;
          case "select":
            yield* fetchVersion({ ...skill, requestedSkill: input.skill, choices: [] }, true);
            break;
          case "origin": {
            const source = current.sources.find((entry) => entry.id === input.sourceId);
            if (!source)
              return yield* new SkillManagerError({ operation: "origin", reason: "not-found" });
            if (source.kind === "local") {
              const real = yield* fs.realPath(input.locator);
              if (real.startsWith(root + path.sep))
                return yield* new SkillManagerError({
                  operation: "origin",
                  reason: "needs-source",
                });
            }
            yield* replace({
              ...skill,
              sourceId: source.id,
              sourceLabel: source.label,
              locator: input.locator,
              requestedSkill: input.skill,
              snapshotOnly: false,
              checkedAt: null,
              failure: null,
              failureReason: null,
              cancelledDigest: null,
            });
            break;
          }
          case "resolve": {
            if (!skill.activeDigest)
              return yield* new SkillManagerError({ operation: "resolve", reason: "not-found" });
            if (input.resolution === "upstream") {
              if ((skill.availableDigest ?? skill.activeDigest) !== input.digest)
                return yield* new SkillManagerError({
                  operation: "resolve",
                  reason: "candidate-changed",
                });
              yield* activate(skill, input.digest, true);
            } else {
              const preserved = yield* packages.inspect(activePath(skill.id));
              if (preserved.digest !== input.digest)
                return yield* new SkillManagerError({
                  operation: "resolve",
                  reason: "candidate-changed",
                });
              const dest = baselinePath(skill.id, preserved.digest);
              if (!(yield* fs.exists(dest))) yield* packages.inspect(preserved.directory, dest);
              const next = {
                ...skill,
                policy: "pinned" as const,
                policyOrigin: "explicit" as const,
                versions: [
                  ...skill.versions.filter((version) => version.digest !== preserved.digest),
                  { digest: preserved.digest, createdAt: yield* now },
                ],
              };
              yield* activate(next, preserved.digest, true);
            }
            break;
          }
          case "unmanage":
            yield* unmanage(skill, input.restore);
            break;
          case "check":
            yield* fetchVersion(skill, false);
            break;
          case "update":
            if (skill.policy === "pinned")
              return yield* new SkillManagerError({ operation: "update", reason: "pinned" });
            if (input.digest && input.digest !== skill.availableDigest)
              return yield* new SkillManagerError({
                operation: "update",
                reason: "candidate-changed",
              });
            if (
              (yield* Ref.get(state)).jobs?.find((job) => job.id === runningJobValue)?.origin ===
                "schedule" &&
              skill.status !== "pending"
            )
              yield* fetchVersion(skill, true);
            else if (skill.availableDigest)
              yield* activate({ ...skill, cancelledDigest: null }, skill.availableDigest);
            else if (skill.status === "pending" && skill.activeDigest)
              yield* activate(skill, skill.activeDigest);
            else yield* fetchVersion(skill, true);
            break;
          case "rollback": {
            if (!skill.versions.some((version) => version.digest === input.digest))
              return yield* new SkillManagerError({ operation: "rollback", reason: "not-found" });
            yield* activate(
              { ...skill, policy: "pinned", policyOrigin: "explicit", cancelledDigest: null },
              input.digest,
            );
            break;
          }
          case "remove":
            yield* remove(skill);
            break;
          case "configure": {
            const targets = yield* selectedTargets(input.targetIds);
            if (yield* host.busy)
              return yield* new SkillManagerError({ operation: "configure", reason: "busy" });
            for (const previous of skill.bindings)
              if (!targets.some((target) => target.directory === previous.directory))
                yield* detach(skill, previous);
            const next = {
              ...skill,
              policy: input.policy,
              policyOrigin: "explicit" as const,
              status: skill.status === "pending" ? ("pending" as const) : ("ready" as const),
              bindings: targets.map((target) => ({
                ...skill.bindings.find((binding) => binding.id === target.id),
                ...target,
                status: "missing" as const,
              })),
            };
            yield* replace(next);
            const linked = skill.activeDigest ? yield* syncBindings(next) : next;
            const failed = linked.bindings.some((binding) => binding.status !== "linked");
            yield* replace({
              ...linked,
              status: next.status === "pending" ? "pending" : failed ? "failed" : "ready",
              failure: failed
                ? "Some targets could not be linked. Resolve conflicts and retry the bindings."
                : null,
            });
            yield* host.refresh([...skill.bindings, ...linked.bindings]);
            break;
          }
        }
      }
    }
  });
  const process = Effect.fn("SkillManager.process")(function* (id: string) {
    const job = (yield* Ref.get(state)).jobs?.find((entry) => entry.id === id);
    if (!job || job.status !== "queued") return;
    const input = job.input;
    const skillId =
      "id" in input
        ? input.id
        : input.type === "install" || input.type === "adopt"
          ? id
          : undefined;
    const before = skillId
      ? (yield* Ref.get(state)).skills.find((skill) => skill.id === skillId)?.activeDigest
      : undefined;
    yield* Ref.set(runningJob, id);
    yield* Ref.set(operation, input.type);
    yield* saveJobs((jobs) =>
      jobs.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status: "running",
              ...(skillId ? { skillId } : {}),
              beforeDigest: before ?? null,
            }
          : entry,
      ),
    );
    yield* execute(input).pipe(
      Effect.matchEffect({
        onFailure: Effect.fn("SkillManager.recordFailure")(function* (cause) {
          const error = isSkillManagerError(cause)
            ? cause
            : new SkillManagerError({ operation: input.type, reason: "io", cause });
          const current = yield* Ref.get(state);
          const attemptedAt = yield* now;
          yield* save({
            ...current,
            lastFailure: error.message,
            lastFailureReason: error.reason,
            skills: current.skills.map((skill) =>
              skill.id === skillId
                ? {
                    ...skill,
                    status:
                      error.reason === "busy" || error.reason === "pinned"
                        ? skill.status
                        : "failed",
                    failure: error.message,
                    failureReason: error.reason,
                    choices: error.choices ?? skill.choices ?? [],
                    lastAttemptAt: attemptedAt,
                  }
                : skill,
            ),
          });
          const finishedAt = yield* now;
          yield* saveJobs((jobs) =>
            jobs.map((entry) =>
              entry.id === id
                ? { ...entry, status: "failed", reason: error.reason, finishedAt }
                : entry,
            ),
          );
        }),
        onSuccess: Effect.fn("SkillManager.recordSuccess")(function* () {
          const resultingSkill = skillId
            ? (yield* Ref.get(state)).skills.find((skill) => skill.id === skillId)
            : undefined;
          const after = resultingSkill?.availableDigest ?? resultingSkill?.activeDigest;
          const finishedAt = yield* now;
          yield* saveJobs((jobs) =>
            jobs.map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    status:
                      entry.status === "cancelled"
                        ? "cancelled"
                        : resultingSkill?.status === "pending"
                          ? "waiting"
                          : resultingSkill?.status === "failed"
                            ? "failed"
                            : "completed",
                    reason:
                      resultingSkill?.status === "failed"
                        ? (resultingSkill.failureReason ?? "io")
                        : entry.reason,
                    finishedAt,
                    afterDigest: after ?? null,
                  }
                : entry,
            ),
          );
        }),
      }),
      Effect.ensuring(
        Ref.set(operation, null).pipe(
          Effect.andThen(Ref.set(runningJob, null)),
          Effect.andThen(SubscriptionRef.update(revision, (n) => n + 1)),
        ),
      ),
    );
    if (
      [
        "install",
        "adopt",
        "remove",
        "unmanage",
        "configure",
        "target.save",
        "target.remove",
      ].includes(input.type)
    )
      yield* refreshDiscovery;
  });
  const worker = yield* makeDrainableWorker(process);
  const enqueue = Effect.fn("SkillManager.enqueue")(
    function* (input: SkillMutation, origin: SkillJob["origin"] = "user") {
      yield* jobLock.withPermits(1)(
        Effect.gen(function* () {
          const operations = input.type === "batch" ? input.operations : [input];
          const seen = new Set<string>();
          for (const action of operations) {
            if (seen.has(actionKey(action))) continue;
            seen.add(actionKey(action));
            if (action.type === "cancel") {
              const finishedAt = yield* now;
              yield* saveJobs((jobs) =>
                jobs.map((job) =>
                  (job.status === "queued" ||
                    job.status === "running" ||
                    job.status === "waiting") &&
                  "id" in job.input &&
                  job.input.id === action.id &&
                  ["update", "check", "rollback"].includes(job.input.type)
                    ? { ...job, status: "cancelled", finishedAt }
                    : job,
                ),
              );
            }
            const current = yield* Ref.get(state);
            const key = actionKey(action);
            if (
              current.jobs?.some(
                (job) =>
                  (job.status === "queued" || job.status === "running") &&
                  actionKey(job.input) === key,
              )
            )
              continue;
            const job: SkillJob = {
              id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
              input: action,
              origin,
              status: "queued",
              createdAt: yield* now,
              finishedAt: null,
              reason: null,
            };
            yield* saveJobs((jobs) => [...jobs, job]);
            yield* worker.enqueue(job.id);
          }
        }),
      );
    },
    Effect.mapError((cause) =>
      isSkillManagerError(cause)
        ? cause
        : new SkillManagerError({ operation: "queue", reason: "io", cause }),
    ),
  );
  const startup = yield* Ref.get(state);
  for (const skill of startup.skills) {
    if (!skill.policyOrigin) yield* replace({ ...skill, policyOrigin: "legacy" });
    if (skill.adoptionState === "preparing") {
      const restored = yield* abortAdoption(skill).pipe(Effect.result);
      if (restored._tag === "Failure")
        yield* replace({
          ...skill,
          status: "failed",
          failureReason: "conflict",
          failure: skillFailureMessage("conflict"),
        });
    } else if (skill.pendingUnmanage)
      yield* enqueue(
        { type: "unmanage", id: skill.id, restore: skill.pendingUnmanage.restore },
        "recovery",
      );
    else if (skill.pendingActivation && !(yield* host.busy)) {
      const { pendingActivation, ...previous } = skill;
      const linked = yield* switchActive({
        ...previous,
        activeDigest: pendingActivation.digest,
        workKey: pendingActivation.workKey,
        availableDigest: null,
      }).pipe(Effect.result);
      if (linked._tag === "Success")
        yield* replace({
          ...linked.success,
          status: linked.success.bindings.some((binding) => binding.status !== "linked")
            ? "failed"
            : "ready",
          phase: "prepared",
        });
      else
        yield* replace({
          ...skill,
          status: "failed",
          failureReason: "interrupted",
          failure: skillFailureMessage("interrupted"),
        });
    } else if (skill.status === "removing")
      yield* enqueue({ type: "remove", id: skill.id }, "recovery");
    else if (skill.status === "fetching")
      yield* replace({
        ...skill,
        status: "failed",
        failure: skillFailureMessage("interrupted"),
        failureReason: "interrupted",
      });
    else if (skill.activeDigest && !(yield* host.busy)) {
      const result = yield* switchActive(skill).pipe(Effect.result);
      if (result._tag === "Success") {
        const linked = result.success;
        const failed = linked.bindings.some((binding) => binding.status !== "linked");
        yield* replace({
          ...linked,
          policyOrigin: linked.policyOrigin ?? "legacy",
          status:
            linked.availableDigest && linked.status === "pending"
              ? "pending"
              : failed
                ? "failed"
                : linked.status === "pending"
                  ? "ready"
                  : linked.status,
          failure: failed ? skillFailureMessage("conflict") : linked.failure,
          failureReason: failed ? "conflict" : (linked.failureReason ?? null),
        });
      }
    }
  }
  const recoveredAt = yield* now;
  yield* saveJobs((jobs) =>
    jobs.map((job) =>
      job.status === "running"
        ? { ...job, status: "failed", reason: "interrupted", finishedAt: recoveredAt }
        : job,
    ),
  );
  for (const job of (yield* Ref.get(state)).jobs ?? [])
    if (job.status === "queued") yield* worker.enqueue(job.id);
  const tick = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const time = yield* Clock.currentTimeMillis;
    for (const skill of current.skills) {
      if (skill.status === "pending" && skill.availableDigest && !skill.snapshotOnly) {
        if (!(yield* host.busy))
          yield* enqueue(
            skill.policy === "pinned"
              ? { type: "rollback", id: skill.id, digest: skill.availableDigest }
              : { type: "update", id: skill.id, digest: skill.availableDigest },
            "schedule",
          );
      } else if (
        (skill.policy === "automatic" || skill.policy === "notify") &&
        skill.status !== "fetching" &&
        !skill.snapshotOnly &&
        current.sources.some((source) => source.id === skill.sourceId && source.enabled) &&
        time -
          Math.max(
            skill.checkedAt ? Date.parse(skill.checkedAt) : 0,
            skill.lastAttemptAt ? Date.parse(skill.lastAttemptAt) : 0,
          ) >=
          24 * 60 * 60 * 1000
      ) {
        yield* enqueue(
          { type: skill.policy === "automatic" ? "update" : "check", id: skill.id },
          "schedule",
        );
      }
    }
  }).pipe(Effect.catch((cause) => Effect.logWarning("Skill update scheduling failed", cause)));
  yield* refreshDiscovery;
  yield* tick.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  const snapshot = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    return {
      ...current,
      skills: current.skills.map((skill) =>
        !skill.failureReason &&
        (skill.policy === "automatic" || skill.policy === "notify") &&
        current.sources.some((source) => source.id === skill.sourceId && !source.enabled)
          ? { ...skill, failureReason: "source-disabled" as const }
          : skill,
      ),
      operation: yield* Ref.get(operation),
      targets: yield* allTargets,
      discovered: yield* Ref.get(discoveries),
      scannedAt: (yield* Ref.get(scannedAt)) ?? (yield* now),
    };
  }).pipe(
    Effect.mapError((cause) =>
      isSkillManagerError(cause)
        ? cause
        : new SkillManagerError({ operation: "snapshot", reason: "io", cause }),
    ),
  );
  return SkillManager.of({
    mutate: enqueue,
    inspect,
    tick,
    snapshot,
    changes: SubscriptionRef.changes(revision).pipe(Stream.mapEffect(() => snapshot)),
    drain: worker.drain,
  });
});
export const layer = Layer.effect(SkillManager, make);
