import * as Crypto from "effect/Crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's symlink API cannot request Windows directory junctions.
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import {
  SkillCatalog,
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
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as SkillPackages from "./SkillPackages.ts";
import * as SkillHost from "./SkillHost.ts";

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
    readonly mutate: (input: SkillMutation) => Effect.Effect<void>;
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
  const operation = yield* Ref.make<string | null>(null);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const save = Effect.fn("SkillManager.save")(function* (next: SkillCatalog) {
    const payload = yield* encode(next);
    yield* sql`INSERT INTO skill_catalog (id, payload) VALUES (1, ${payload}) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`;
    yield* Ref.set(state, next);
    yield* SubscriptionRef.update(revision, (n) => n + 1);
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
      selected.push(target);
    }
    return selected;
  });
  const activePath = (id: string) => path.join(root, "active", id);
  const versionPath = (id: string, digest: string) => path.join(root, "versions", id, digest);
  const linkPath = (skill: ManagedSkill, target: SkillTarget) =>
    path.join(target.directory, skill.name);
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
    const expected = versionPath(skill.id, skill.activeDigest);
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
  const activate = Effect.fn("SkillManager.activate")(function* (
    skill: ManagedSkill,
    digest: string,
  ) {
    if (yield* host.busy) {
      yield* replace({ ...skill, availableDigest: digest, status: "pending", failure: null });
      return;
    }
    // Persist the desired version first so recovery can complete an interrupted link switch.
    const desired: ManagedSkill = {
      ...skill,
      activeDigest: digest,
      availableDigest: null,
      status: "pending",
      failure: null,
    };
    yield* replace(desired);
    const linked = yield* switchActive(desired);
    const failed = linked.bindings.some((target) => target.status !== "linked");
    yield* replace({
      ...linked,
      status: failed ? "failed" : "ready",
      failure: failed
        ? "Some targets could not be linked. Resolve conflicts and retry the bindings."
        : null,
    });
    yield* host.refresh(linked.bindings);
  });
  const fetchVersion = Effect.fn("SkillManager.fetchVersion")(function* (
    skill: ManagedSkill,
    apply: boolean,
  ) {
    const source = (yield* Ref.get(state)).sources.find((entry) => entry.id === skill.sourceId);
    if (!source) return yield* new SkillManagerError({ operation: "fetch", reason: "not-found" });
    yield* replace({ ...skill, status: "fetching", failure: null, checkedAt: yield* now });
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
      if (!(yield* fs.exists(destination))) yield* fs.rename(fetched.directory, destination);
      const date = yield* now;
      const next: ManagedSkill = {
        ...skill,
        name: fetched.name,
        description: fetched.description,
        checkedAt: date,
        status: "ready",
        failure: null,
        availableDigest: fetched.digest === skill.activeDigest ? null : fetched.digest,
        versions: skill.versions.some((version) => version.digest === fetched.digest)
          ? skill.versions
          : [...skill.versions, { digest: fetched.digest, createdAt: date }],
      };
      yield* replace(next);
      if (apply) yield* activate(next, fetched.digest);
    }).pipe(
      Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  });
  const remove = Effect.fn("SkillManager.remove")(function* (skill: ManagedSkill) {
    if (yield* host.busy)
      return yield* new SkillManagerError({ operation: "remove", reason: "busy" });
    yield* replace({ ...skill, status: "removing" });
    for (const target of skill.bindings) yield* detach(skill, target);
    if (yield* filePresent(activePath(skill.id))) yield* fs.remove(activePath(skill.id));
    yield* fs.remove(path.join(root, "versions", skill.id), { recursive: true, force: true });
    const current = yield* Ref.get(state);
    yield* save({ ...current, skills: current.skills.filter((entry) => entry.id !== skill.id) });
    yield* host.refresh(skill.bindings);
  });
  const execute = Effect.fn("SkillManager.execute")(function* (input: SkillMutation) {
    const current = yield* Ref.get(state);
    yield* save({ ...current, lastFailure: null });
    switch (input.type) {
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
        const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
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
          policy: input.policy,
          status: "fetching",
          failure: null,
          checkedAt: null,
        };
        yield* replace(skill);
        yield* fetchVersion(skill, true).pipe(
          Effect.catch((cause) =>
            get(id).pipe(
              Effect.flatMap((latest) =>
                replace({
                  ...latest,
                  status: "failed",
                  failure: isSkillManagerError(cause)
                    ? cause.message
                    : "Skill installation failed.",
                }),
              ),
            ),
          ),
        );
        return;
      }
      default: {
        const skill = yield* get(input.id);
        switch (input.type) {
          case "check":
            yield* fetchVersion(skill, false);
            break;
          case "update":
            if (skill.availableDigest) yield* activate(skill, skill.availableDigest);
            else if (skill.status === "pending" && skill.activeDigest)
              yield* activate(skill, skill.activeDigest);
            else yield* fetchVersion(skill, true);
            break;
          case "rollback": {
            if (!skill.versions.some((version) => version.digest === input.digest))
              return yield* new SkillManagerError({ operation: "rollback", reason: "not-found" });
            yield* activate({ ...skill, policy: "pinned" }, input.digest);
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
              status: skill.status === "pending" ? ("pending" as const) : ("ready" as const),
              bindings: targets.map((target) => ({ ...target, status: "missing" as const })),
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
  const process = Effect.fn("SkillManager.process")(function* (input: SkillMutation) {
    yield* Ref.set(operation, input.type);
    yield* SubscriptionRef.update(revision, (n) => n + 1);
    yield* execute(input).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const error = isSkillManagerError(cause)
            ? cause
            : new SkillManagerError({ operation: input.type, reason: "io", cause });
          const current = yield* Ref.get(state);
          yield* save({
            ...current,
            lastFailure: error.message,
            skills:
              "id" in input
                ? current.skills.map((skill) =>
                    skill.id === input.id
                      ? {
                          ...skill,
                          status: error.reason === "busy" ? skill.status : ("failed" as const),
                          failure: error.message,
                        }
                      : skill,
                  )
                : current.skills,
          });
        }),
      ),
      Effect.ensuring(
        Ref.set(operation, null).pipe(
          Effect.andThen(SubscriptionRef.update(revision, (n) => n + 1)),
        ),
      ),
    );
  });
  const worker = yield* makeDrainableWorker(process);
  for (const skill of (yield* Ref.get(state)).skills) {
    if (skill.status === "removing") yield* worker.enqueue({ type: "remove", id: skill.id });
    else if (skill.status === "fetching")
      yield* replace({
        ...skill,
        status: "failed",
        failure: "Installation was interrupted. Retry the update.",
      });
    else if (skill.activeDigest && !(yield* host.busy)) {
      const result = yield* switchActive(skill).pipe(Effect.result);
      if (result._tag === "Success") {
        const linked = result.success;
        const failed = linked.bindings.some((binding) => binding.status !== "linked");
        yield* replace({
          ...linked,
          status:
            linked.availableDigest && linked.status === "pending"
              ? "pending"
              : failed
                ? "failed"
                : "ready",
          failure: failed
            ? "Some targets could not be linked. Resolve conflicts and retry the bindings."
            : null,
        });
      }
    }
  }
  const tick = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const time = yield* Clock.currentTimeMillis;
    for (const skill of current.skills) {
      if (skill.status === "pending") {
        if (!(yield* host.busy)) yield* worker.enqueue({ type: "update", id: skill.id });
      } else if (
        (skill.policy === "automatic" || skill.policy === "notify") &&
        skill.status !== "fetching" &&
        current.sources.some((source) => source.id === skill.sourceId && source.enabled) &&
        (!skill.checkedAt || time - Date.parse(skill.checkedAt) >= 24 * 60 * 60 * 1000)
      ) {
        yield* worker.enqueue({
          type: skill.policy === "automatic" ? "update" : "check",
          id: skill.id,
        });
      }
    }
  }).pipe(Effect.catch((cause) => Effect.logWarning("Skill update scheduling failed", cause)));
  yield* tick.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  const snapshot = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const discovered = yield* host.discovered;
    const managedPaths = new Set(
      current.skills.flatMap((skill) =>
        skill.bindings.map((target) => path.join(linkPath(skill, target), "SKILL.md")),
      ),
    );
    return {
      ...current,
      operation: yield* Ref.get(operation),
      targets: yield* allTargets,
      discovered: discovered.filter(
        (skill) => !managedPaths.has(skill.path) && !skill.path.startsWith(root + path.sep),
      ),
    };
  }).pipe(
    Effect.mapError((cause) =>
      isSkillManagerError(cause)
        ? cause
        : new SkillManagerError({ operation: "snapshot", reason: "io", cause }),
    ),
  );
  return SkillManager.of({
    mutate: worker.enqueue,
    snapshot,
    changes: SubscriptionRef.changes(revision).pipe(Stream.mapEffect(() => snapshot)),
    drain: worker.drain,
  });
});
export const layer = Layer.effect(SkillManager, make);
