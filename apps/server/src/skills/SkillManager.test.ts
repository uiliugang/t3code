import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
      policy: "manual",
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
        const payload = yield* encodeCatalog({
          ...catalog,
          skills: [
            {
              ...checked,
              activeDigest: checked.availableDigest,
              availableDigest: null,
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
});
