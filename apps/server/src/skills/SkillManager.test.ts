import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { SkillCatalog } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SkillManager from "./SkillManager.ts";
import * as SkillPackages from "./SkillPackages.ts";
import * as SkillHost from "./SkillHost.ts";

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-test-" });
  const source = `${directory}/source`;
  const target = `${directory}/agent/skills`;
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(
    `${source}/SKILL.md`,
    "---\nname: review\ndescription: Review a change\n---\nReview it.\n",
  );
  yield* fs.writeFileString(`${source}/script.sh`, "first");
  const busy = yield* Ref.make(false);
  const dependencies = yield* Layer.build(
    Layer.mergeAll(
      SkillPackages.layer,
      Layer.succeed(SkillHost.SkillHost, {
        targets: Effect.succeed([{ id: "fixture", label: "Fixture", directory: target }]),
        discovered: Effect.succeed([]),
        busy: Ref.get(busy),
        refresh: () => Effect.void,
      }),
      Sqlite.layerMemory,
    ).pipe(Layer.provideMerge(ServerConfig.layerTest(directory, directory))),
  );
  const restart = Layer.build(
    SkillManager.layer.pipe(Layer.provide(Layer.succeedContext(dependencies))),
  ).pipe(Effect.map((context) => Context.get(context, SkillManager.SkillManager)));
  const manager = yield* restart;
  const sql = Context.get(dependencies, SqlClient.SqlClient);
  const install = manager
    .mutate({
      type: "install",
      sourceId: "local",
      locator: source,
      skill: "",
      targetIds: ["fixture"],
    })
    .pipe(Effect.andThen(manager.drain));
  return { fs, directory, source, target, manager, install, busy, restart, sql };
});
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(SkillCatalog));

describe("SkillManager", () => {
  it.effect(
    "shares a full package, detects resource changes, rolls back and only removes managed links",
    () =>
      Effect.gen(function* () {
        const { fs, source, target, manager, install } = yield* harness;
        yield* install;
        const first = (yield* manager.snapshot).skills[0]!;
        expect(first.status).toBe("ready");
        expect(first.policy).toBe("automatic");
        expect(first.sourceLabel).toBe("Local import");
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
        yield* fs.writeFileString(`${source}/script.sh`, "second");
        yield* manager.mutate({ type: "check", id: first.id });
        yield* manager.drain;
        const checked = (yield* manager.snapshot).skills[0]!;
        expect(checked.availableDigest).not.toBe(first.activeDigest);
        expect(checked.versions).toHaveLength(2);
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
        yield* manager.mutate({ type: "update", id: first.id });
        yield* manager.drain;
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("second");
        yield* manager.mutate({ type: "rollback", id: first.id, digest: first.activeDigest! });
        yield* manager.drain;
        expect((yield* manager.snapshot).skills[0]?.policy).toBe("pinned");
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
        yield* fs.remove(`${target}/review`);
        yield* fs.makeDirectory(`${target}/review`);
        yield* fs.writeFileString(`${target}/review/user.txt`, "owned by user");
        yield* manager.mutate({ type: "remove", id: first.id });
        yield* manager.drain;
        expect(yield* fs.readFileString(`${target}/review/user.txt`)).toBe("owned by user");
        expect((yield* manager.snapshot).skills[0]?.status).toBe("failed");
        yield* fs.remove(`${target}/review`, { recursive: true });
        yield* manager.mutate({ type: "remove", id: first.id });
        yield* manager.drain;
        expect((yield* manager.snapshot).skills).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves conflicting directories and defers activation while agents are busy", () =>
    Effect.gen(function* () {
      const { fs, target, manager, install, busy } = yield* harness;
      yield* fs.makeDirectory(`${target}/review`, { recursive: true });
      yield* fs.writeFileString(`${target}/review/SKILL.md`, "original");
      yield* Ref.set(busy, true);
      yield* install;
      const pending = (yield* manager.snapshot).skills[0]!;
      expect(pending.status).toBe("pending");
      expect(pending.activeDigest).toBeNull();
      yield* manager.mutate({ type: "remove", id: pending.id });
      yield* manager.drain;
      expect((yield* manager.snapshot).skills[0]?.status).toBe("pending");
      expect(yield* fs.readFileString(`${target}/review/SKILL.md`)).toBe("original");
      yield* Ref.set(busy, false);
      yield* manager.mutate({ type: "update", id: pending.id });
      yield* manager.drain;
      expect(yield* fs.readFileString(`${target}/review/SKILL.md`)).toBe("original");
      expect((yield* manager.snapshot).skills[0]?.bindings[0]?.status).toBe("conflict");
      yield* fs.remove(`${target}/review`, { recursive: true });
      yield* manager.mutate({
        type: "configure",
        id: pending.id,
        policy: "manual",
        targetIds: ["fixture"],
      });
      yield* manager.drain;
      expect((yield* manager.snapshot).skills[0]?.bindings[0]?.status).toBe("linked");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "recovers a committed version switch without fetching and guards referenced sources and targets",
    () =>
      Effect.gen(function* () {
        const { fs, source, target, manager, install, restart, sql } = yield* harness;
        yield* install;
        yield* fs.writeFileString(`${source}/script.sh`, "second");
        const first = (yield* manager.snapshot).skills[0]!;
        yield* manager.mutate({ type: "check", id: first.id });
        yield* manager.drain;
        const catalog = yield* manager.snapshot;
        const checked = catalog.skills[0]!;
        const working = yield* fs.realPath(`${target}/review`);
        yield* fs.copy(source, working.replace(/[^/\\]+$/, "prepared"));
        const payload = yield* encodeCatalog({
          ...catalog,
          skills: [
            {
              ...checked,
              pendingActivation: { digest: checked.availableDigest!, workKey: "prepared" },
              status: "pending",
            },
          ],
        });
        yield* sql`UPDATE skill_catalog SET payload = ${payload} WHERE id = 1`;
        yield* fs.remove(source, { recursive: true });
        const recovered = yield* restart;
        yield* recovered.drain;
        expect((yield* recovered.snapshot).skills[0]?.status).toBe("ready");
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("second");
        yield* recovered.mutate({ type: "source.remove", sourceId: "local" });
        yield* recovered.drain;
        expect((yield* recovered.snapshot).sources.some((entry) => entry.id === "local")).toBe(
          true,
        );
        yield* recovered.mutate({ type: "target.remove", targetId: "fixture" });
        yield* recovered.drain;
        expect((yield* recovered.snapshot).lastFailure).toMatch(/conflicts/);
        yield* recovered.mutate({
          type: "configure",
          id: first.id,
          policy: "pinned",
          targetIds: [],
        });
        yield* recovered.drain;
        expect(yield* fs.exists(`${target}/review`)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects disabled sources and package links escaping their root", () =>
    Effect.gen(function* () {
      const { fs, directory, source, manager, install } = yield* harness;
      yield* manager.mutate({
        type: "install",
        sourceId: "meituan",
        locator: "mtsso-skills-official",
        skill: "",
        targetIds: [],
        policy: "manual",
      });
      yield* manager.drain;
      expect((yield* manager.snapshot).lastFailure).toMatch(/Enable this skill source/);
      yield* fs.writeFileString(`${directory}/private`, "secret");
      yield* fs.symlink(`${directory}/private`, `${source}/outside`);
      yield* install;
      const failed = (yield* manager.snapshot).skills[0]!;
      expect(failed.status).toBe("failed");
      expect(failed.activeDigest).toBeNull();
      expect(failed.versions).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("deduplicates physical discoveries, previews and restores a taken-over directory", () =>
    Effect.gen(function* () {
      const { fs, source, target, manager, install, restart, sql } = yield* harness;
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.copy(source, `${target}/review`);
      yield* fs.writeFileString(
        `${target}/.mtskills-source.jsonl`,
        '{"skillName":"review","sourceType":"mt-name","sourceId":"review-package"}\n',
      );
      yield* manager.mutate({
        type: "target.save",
        target: { id: "alias", label: "Alias", directory: `${target}/../alias` },
      });
      yield* fs.symlink(target, `${target}/../alias`);
      yield* manager.mutate({ type: "refresh" });
      yield* manager.drain;
      const discovered = (yield* manager.snapshot).discovered;
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.targetIds).toHaveLength(2);
      expect(discovered[0]?.origin?.locator).toBe("review-package");
      const preview = yield* manager.inspect({ type: "adopt", path: `${target}/review` });
      yield* manager.mutate({
        type: "adopt",
        path: `${target}/review`,
        digest: preview.digest,
        mode: "takeover",
        targetIds: ["fixture", "alias"],
      });
      yield* manager.drain;
      const adopted = (yield* manager.snapshot).skills[0]!;
      expect(adopted.policy).toBe("automatic");
      expect(adopted.bindings).toHaveLength(1);
      expect(adopted.sourceId).toBe("meituan");
      expect(adopted.backups).toHaveLength(1);
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      yield* manager.mutate({ type: "unmanage", id: adopted.id, restore: true });
      yield* manager.drain;
      expect((yield* manager.snapshot).skills).toHaveLength(0);
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      expect((yield* fs.stat(`${target}/review`)).type).toBe("Directory");
      yield* fs.remove(`${target}/review`, { recursive: true });
      yield* install;
      const installed = (yield* manager.snapshot).skills[0]!;
      yield* fs.remove(`${target}/review`);
      yield* fs.copy(source, `${target}/review`);
      const catalog = yield* manager.snapshot;
      const payload = yield* encodeCatalog({
        ...catalog,
        skills: [
          { ...installed, pendingUnmanage: { restore: false, digest: installed.activeDigest! } },
        ],
      });
      yield* sql`UPDATE skill_catalog SET payload = ${payload} WHERE id = 1`;
      const recovered = yield* restart;
      yield* recovered.drain;
      expect((yield* recovered.snapshot).skills).toHaveLength(0);
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      expect((yield* fs.stat(`${target}/review`)).type).toBe("Directory");
      const interrupted = yield* harness;
      yield* interrupted.fs.makeDirectory(interrupted.target, { recursive: true });
      yield* interrupted.fs.copy(interrupted.source, `${interrupted.target}/review`);
      const inspection = yield* interrupted.manager.inspect({
        type: "adopt",
        path: `${interrupted.target}/review`,
      });
      yield* interrupted.manager.mutate({
        type: "adopt",
        path: `${interrupted.target}/review`,
        digest: inspection.digest,
        mode: "takeover",
        targetIds: ["fixture"],
      });
      yield* interrupted.manager.drain;
      const interruptedCatalog = yield* interrupted.manager.snapshot;
      const interruptedPayload = yield* encodeCatalog({
        ...interruptedCatalog,
        skills: interruptedCatalog.skills.map((skill) => ({
          ...skill,
          adoptionState: "preparing" as const,
        })),
      });
      yield* interrupted.sql`UPDATE skill_catalog SET payload = ${interruptedPayload} WHERE id = 1`;
      const adoptionRecovered = yield* interrupted.restart;
      yield* adoptionRecovered.drain;
      expect((yield* adoptionRecovered.snapshot).skills).toHaveLength(0);
      expect((yield* adoptionRecovered.snapshot).discovered).toHaveLength(1);
      expect(yield* interrupted.fs.readFileString(`${interrupted.target}/review/script.sh`)).toBe(
        "first",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("protects local changes and the reviewed candidate, and pins preserved content", () =>
    Effect.gen(function* () {
      const { fs, source, target, manager, install } = yield* harness;
      yield* install;
      const first = (yield* manager.snapshot).skills[0]!;
      yield* fs.writeFileString(`${source}/script.sh`, "upstream");
      yield* manager.mutate({ type: "check", id: first.id });
      yield* manager.drain;
      yield* fs.writeFileString(`${target}/review/script.sh`, "user edit");
      yield* manager.mutate({ type: "update", id: first.id });
      yield* manager.drain;
      expect((yield* manager.snapshot).skills[0]?.failureReason).toBe("local-changes");
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("user edit");
      const diff = yield* manager.inspect({ type: "diff", id: first.id });
      expect(diff.files.find((file) => file.path === "script.sh")).toMatchObject({
        status: "changed",
        before: "user edit",
        after: "upstream",
      });
      yield* manager.mutate({
        type: "resolve",
        id: first.id,
        resolution: "upstream",
        digest: first.activeDigest!,
      });
      yield* manager.drain;
      expect((yield* manager.snapshot).skills[0]?.failureReason).toBe("candidate-changed");
      yield* manager.mutate({
        type: "resolve",
        id: first.id,
        resolution: "keep",
        digest: diff.digest,
      });
      yield* manager.drain;
      expect((yield* manager.snapshot).skills[0]?.policy).toBe("pinned");
      expect((yield* manager.snapshot).skills[0]?.activeDigest).toBe(diff.digest);
      yield* manager.mutate({ type: "policy", id: first.id, policy: "automatic" });
      yield* manager.mutate({ type: "check", id: first.id });
      yield* manager.drain;
      const candidate = (yield* manager.snapshot).skills[0]?.availableDigest;
      yield* manager.mutate({ type: "update", id: first.id, digest: candidate! });
      yield* manager.drain;
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("upstream");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "cancels waiting activation, deduplicates a batch and preserves individual results across restart",
    () =>
      Effect.gen(function* () {
        const { fs, source, target, manager, install, busy, restart } = yield* harness;
        yield* install;
        const first = (yield* manager.snapshot).skills[0]!;
        yield* fs.writeFileString(`${source}/script.sh`, "second");
        yield* Ref.set(busy, true);
        yield* manager.mutate({
          type: "batch",
          operations: [
            { type: "update", id: first.id },
            { type: "update", id: first.id },
            { type: "check", id: "missing" },
          ],
        });
        yield* manager.drain;
        expect((yield* manager.snapshot).skills[0]?.status).toBe("pending");
        expect(
          (yield* manager.snapshot).jobs?.filter((job) => job.input.type === "update"),
        ).toHaveLength(1);
        expect(
          (yield* manager.snapshot).jobs?.find((job) => job.input.type === "check")?.reason,
        ).toBe("not-found");
        yield* manager.mutate({ type: "cancel", id: first.id });
        yield* manager.drain;
        yield* Ref.set(busy, false);
        yield* manager.tick;
        yield* manager.drain;
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
        const recovered = yield* restart;
        yield* recovered.drain;
        expect((yield* recovered.snapshot).jobs?.some((job) => job.reason === "not-found")).toBe(
          true,
        );
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps unknown takeovers as snapshots and rejects stale previews and external packages",
    () =>
      Effect.gen(function* () {
        const { fs, source, target, manager, directory } = yield* harness;
        yield* fs.makeDirectory(target, { recursive: true });
        yield* fs.copy(source, `${target}/review`);
        const preview = yield* manager.inspect({ type: "adopt", path: `${target}/review` });
        yield* fs.writeFileString(`${target}/review/script.sh`, "changed since preview");
        yield* manager.mutate({
          type: "adopt",
          path: `${target}/review`,
          digest: preview.digest,
          mode: "takeover",
          targetIds: ["fixture"],
        });
        yield* manager.drain;
        expect((yield* manager.snapshot).lastFailureReason).toBe("candidate-changed");
        const fresh = yield* manager.inspect({ type: "adopt", path: `${target}/review` });
        yield* manager.mutate({
          type: "adopt",
          path: `${target}/review`,
          digest: fresh.digest,
          mode: "takeover",
          targetIds: ["fixture"],
        });
        yield* manager.drain;
        const skill = (yield* manager.snapshot).skills[0]!;
        expect(skill.snapshotOnly).toBe(true);
        expect(skill.policy).toBe("automatic");
        yield* manager.mutate({ type: "check", id: skill.id });
        yield* manager.drain;
        expect((yield* manager.snapshot).skills[0]?.failureReason).toBe("needs-source");
        yield* manager.mutate({
          type: "origin",
          id: skill.id,
          sourceId: "local",
          locator: source,
          skill: "",
        });
        yield* manager.mutate({ type: "check", id: skill.id });
        yield* manager.drain;
        expect((yield* manager.snapshot).skills[0]?.snapshotOnly).toBe(false);
        yield* fs.makeDirectory(`${directory}/plugins`, { recursive: true });
        yield* fs.copy(source, `${directory}/plugins/owned`);
        yield* manager.mutate({
          type: "adopt",
          path: `${directory}/plugins/owned`,
          digest: preview.digest,
          mode: "copy",
          targetIds: [],
        });
        yield* manager.drain;
        expect((yield* manager.snapshot).lastFailureReason).toBe("external");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "checks daily once, applies automatically when idle, and honors notify and cancellation",
    () =>
      Effect.gen(function* () {
        const { fs, source, target, manager, install, busy } = yield* harness;
        yield* install;
        const first = (yield* manager.snapshot).skills[0]!;
        yield* fs.writeFileString(`${source}/script.sh`, "daily");
        yield* Ref.set(busy, true);
        yield* TestClock.adjust("1 day");
        yield* manager.tick;
        yield* manager.drain;
        expect((yield* manager.snapshot).skills[0]?.status).toBe("pending");
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
        yield* Ref.set(busy, false);
        yield* manager.tick;
        yield* manager.drain;
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("daily");
        yield* manager.mutate({ type: "policy", id: first.id, policy: "notify" });
        yield* manager.drain;
        yield* fs.writeFileString(`${source}/script.sh`, "notify");
        yield* TestClock.adjust("1 day");
        yield* manager.tick;
        yield* manager.drain;
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("daily");
        expect((yield* manager.snapshot).skills[0]?.availableDigest).not.toBeNull();
        const jobs = (yield* manager.snapshot).jobs?.length;
        yield* manager.tick;
        yield* manager.drain;
        expect((yield* manager.snapshot).jobs?.length).toBe(jobs);
        yield* manager.mutate({ type: "policy", id: first.id, policy: "pinned" });
        yield* manager.drain;
        const stopped = yield* manager.snapshot;
        yield* fs.writeFileString(`${source}/script.sh`, "do not update");
        yield* TestClock.adjust("1 day");
        yield* manager.tick;
        yield* manager.drain;
        expect((yield* manager.snapshot).jobs?.length).toBe(stopped.jobs?.length);
        expect((yield* manager.snapshot).skills[0]?.checkedAt).toBe(stopped.skills[0]?.checkedAt);
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("daily");
        yield* Ref.set(busy, true);
        yield* manager.mutate({ type: "policy", id: first.id, policy: "automatic" });
        yield* manager.drain;
        yield* manager.tick;
        yield* manager.drain;
        expect((yield* manager.snapshot).skills[0]?.status).toBe("pending");
        yield* manager.mutate({ type: "policy", id: first.id, policy: "notify" });
        yield* manager.drain;
        yield* Ref.set(busy, false);
        yield* manager.tick;
        yield* manager.drain;
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("daily");
        expect(
          (yield* manager.snapshot).jobs?.filter((job) => job.status === "waiting"),
        ).toHaveLength(0);
        yield* manager.mutate({ type: "update", id: first.id });
        yield* manager.drain;
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("do not update");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("replays durable queued jobs once and exposes multiple skill choices", () =>
    Effect.gen(function* () {
      const { fs, directory, source, manager, restart, sql } = yield* harness;
      const packageRoot = `${directory}/multi`;
      yield* fs.makeDirectory(packageRoot);
      yield* fs.copy(source, `${packageRoot}/one`);
      yield* fs.copy(source, `${packageRoot}/two`);
      yield* fs.writeFileString(
        `${packageRoot}/two/SKILL.md`,
        "---\nname: second\ndescription: Another skill\n---\n",
      );
      yield* manager.mutate({
        type: "install",
        sourceId: "local",
        locator: packageRoot,
        skill: "",
        targetIds: [],
      });
      yield* manager.drain;
      const snapshot = yield* manager.snapshot;
      const failed = snapshot.skills[0]!;
      expect(failed.choices).toEqual(["review", "second"]);
      const payload = yield* encodeCatalog({
        ...snapshot,
        jobs: [
          ...(snapshot.jobs ?? []),
          {
            id: "queued-selection",
            input: { type: "select", id: failed.id, skill: "second" },
            origin: "user",
            status: "queued",
            createdAt: "2026-01-01T00:00:00.000Z",
            finishedAt: null,
            reason: null,
          },
        ],
      });
      yield* sql`UPDATE skill_catalog SET payload = ${payload} WHERE id = 1`;
      const recovered = yield* restart;
      yield* recovered.drain;
      expect((yield* recovered.snapshot).skills[0]?.name).toBe("second");
      expect(
        (yield* recovered.snapshot).jobs?.find((job) => job.id === "queued-selection")?.status,
      ).toBe("completed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
