import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { SkillCatalog } from "@t3tools/contracts";
import { skillSelection } from "@t3tools/shared/skillsUi";
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
  const reported = yield* Ref.make<ReadonlyArray<{ name: string; path: string; provider: string }>>(
    [],
  );
  const dependencies = yield* Layer.build(
    Layer.mergeAll(
      SkillPackages.layer,
      Layer.succeed(SkillHost.SkillHost, {
        targets: Effect.succeed([{ id: "fixture", label: "Fixture", directory: target }]),
        discovered: Ref.get(reported),
        busy: Ref.get(busy),
        refresh: () => Effect.void,
      }),
      Sqlite.layerMemory,
    ).pipe(Layer.provideMerge(ServerConfig.layerTest(directory, directory))),
  );
  const restartWithFileSystem = (fileSystem: FileSystem.FileSystem) =>
    Layer.build(
      SkillManager.layer.pipe(
        Layer.provide(
          Layer.succeedContext(Context.add(dependencies, FileSystem.FileSystem, fileSystem)),
        ),
      ),
    ).pipe(Effect.map((context) => Context.get(context, SkillManager.SkillManager)));
  const restart = restartWithFileSystem(fs);
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
  return {
    fs,
    directory,
    source,
    target,
    manager,
    install,
    busy,
    reported,
    restart,
    restartWithFileSystem,
    sql,
  };
});
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(SkillCatalog));

describe("SkillManager", () => {
  it.effect(
    "removes empty physical locations across aliases and preserves shared or populated locations",
    () =>
      Effect.gen(function* () {
        const { fs, directory, source, target, manager, reported, restart } = yield* harness;
        yield* fs.makeDirectory(target, { recursive: true });
        yield* fs.writeFileString(`${target}/notes.txt`, "Keep non-skill files");
        yield* fs.symlink(target, `${directory}/alias`);
        yield* manager.mutate({
          type: "target.save",
          target: { id: "alias", label: "Alias", directory: `${directory}/alias` },
        });
        yield* manager.mutate({
          type: "target.save",
          target: { id: "directory:shared", label: "Shared", directory: `${directory}/shared` },
        });
        yield* manager.drain;
        yield* manager.mutate({ type: "target.remove", targetId: "directory:shared" });
        yield* manager.drain;
        expect((yield* manager.snapshot).lastFailureReason).toBe("conflict");
        yield* fs.copy(source, `${target}/review`);
        yield* manager.mutate({ type: "target.remove", targetId: "alias" });
        yield* manager.drain;
        expect((yield* manager.snapshot).lastFailureReason).toBe("conflict");
        expect(
          (yield* manager.snapshot).targets.find((entry) => entry.id === "fixture")?.hasSkills,
        ).toBe(true);
        yield* fs.remove(`${target}/review`, { recursive: true });
        yield* fs.makeDirectory(`${target}/bundle`);
        yield* fs.copy(source, `${target}/bundle/review`);
        yield* Ref.set(reported, [
          { name: "review", path: `${target}/bundle/review/SKILL.md`, provider: "Fixture" },
        ]);
        yield* manager.mutate({ type: "target.remove", targetId: "alias" });
        yield* manager.drain;
        expect((yield* manager.snapshot).lastFailureReason).toBe("conflict");
        yield* fs.remove(`${target}/bundle`, { recursive: true });
        yield* Ref.set(reported, []);
        yield* manager.mutate({ type: "target.remove", targetId: "alias" });
        yield* manager.drain;
        expect((yield* manager.snapshot).targets.map((entry) => entry.id)).toEqual([
          "directory:shared",
        ]);
        expect(yield* fs.readFileString(`${target}/notes.txt`)).toBe("Keep non-skill files");
        yield* fs.copy(source, `${target}/review`);
        yield* Ref.set(reported, [
          { name: "review", path: `${directory}/alias/review/SKILL.md`, provider: "Fixture" },
        ]);
        const recovered = yield* restart;
        expect((yield* recovered.snapshot).targets.map((entry) => entry.id)).toEqual([
          "directory:shared",
        ]);
        expect((yield* recovered.snapshot).discovered).toEqual([]);
        yield* recovered.mutate({
          type: "target.save",
          target: { id: "fixture", label: "Fixture", directory: target },
        });
        yield* recovered.drain;
        expect(
          (yield* recovered.snapshot).targets.find((entry) => entry.id === "fixture")?.enabled,
        ).toBe(true);
        expect((yield* recovered.snapshot).discovered.map((entry) => entry.name)).toEqual([
          "review",
        ]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "disables a physical location, detaches managed links and keeps original files through restart",
    () =>
      Effect.gen(function* () {
        const { fs, directory, source, target, manager, install, busy, reported, restart } =
          yield* harness;
        yield* install;
        const first = (yield* manager.snapshot).skills[0]!;
        yield* fs.copy(source, `${target}/notes`);
        yield* fs.writeFileString(
          `${target}/notes/SKILL.md`,
          "---\nname: notes\ndescription: Original notes\n---\n",
        );
        yield* fs.symlink(target, `${directory}/alias`);
        yield* Ref.set(reported, [
          { name: "notes", path: `${directory}/alias/notes/SKILL.md`, provider: "Fixture" },
        ]);
        yield* manager.mutate({
          type: "target.save",
          target: { id: "alias", label: "Alias", directory: `${directory}/alias` },
        });
        yield* manager.drain;
        expect((yield* manager.snapshot).discovered.map((entry) => entry.name)).toContain("notes");
        yield* Ref.set(busy, true);
        yield* manager.mutate({ type: "target.configure", targetId: "alias", enabled: false });
        yield* manager.drain;
        expect((yield* manager.snapshot).lastFailureReason).toBe("busy");
        expect((yield* manager.snapshot).skills[0]?.bindings).toHaveLength(1);
        yield* Ref.set(busy, false);
        yield* manager.mutate({ type: "target.configure", targetId: "alias", enabled: false });
        yield* manager.drain;
        const disabled = yield* manager.snapshot;
        expect(disabled.targets).toHaveLength(2);
        expect(disabled.targets.every((entry) => entry.enabled === false && entry.hasSkills)).toBe(
          true,
        );
        expect(disabled.skills[0]?.bindings).toEqual([]);
        expect(disabled.discovered).toEqual([]);
        expect(yield* fs.exists(`${target}/review`)).toBe(false);
        expect(yield* fs.readFileString(`${target}/notes/script.sh`)).toBe("first");
        const recovered = yield* restart;
        expect((yield* recovered.snapshot).targets.every((entry) => entry.enabled === false)).toBe(
          true,
        );
        yield* recovered.mutate({
          type: "configure",
          id: first.id,
          policy: "pinned",
          targetIds: ["fixture"],
        });
        yield* recovered.drain;
        expect((yield* recovered.snapshot).lastFailureReason).toBe("target-disabled");
        expect((yield* recovered.snapshot).skills[0]?.bindings).toEqual([]);
        yield* recovered.mutate({ type: "target.remove", targetId: "fixture" });
        yield* recovered.drain;
        expect((yield* recovered.snapshot).lastFailureReason).toBe("conflict");
        yield* recovered.mutate({ type: "target.configure", targetId: "fixture", enabled: true });
        yield* recovered.drain;
        expect((yield* recovered.snapshot).targets.every((entry) => entry.enabled)).toBe(true);
        expect((yield* recovered.snapshot).discovered.map((entry) => entry.name)).toContain(
          "notes",
        );
        expect((yield* recovered.snapshot).skills[0]?.bindings).toEqual([]);
        yield* recovered.mutate({
          type: "configure",
          id: first.id,
          policy: "pinned",
          targetIds: ["fixture", "alias"],
        });
        yield* recovered.drain;
        expect((yield* recovered.snapshot).skills[0]?.bindings).toHaveLength(1);
        expect((yield* recovered.snapshot).skills[0]?.failureReason).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("persists installer diagnostics and clears them after a successful retry", () =>
    Effect.gen(function* () {
      const { fs, directory, source, manager, restart } = yield* harness;
      const executable = `${directory}/installer.mjs`;
      yield* fs.writeFileString(
        executable,
        '#!/usr/bin/env node\nconsole.error("ERR_UNKNOWN_BUILTIN_MODULE: node:stream/promises");\nprocess.exit(1);\n',
      );
      yield* fs.chmod(executable, 0o755);
      yield* manager.mutate({
        type: "source.save",
        source: {
          id: "community",
          label: "Git / HTTP",
          kind: "skills",
          enabled: true,
          executable,
          registry: "",
        },
      });
      yield* manager.drain;
      yield* manager.mutate({ type: "source.check", sourceId: "community" });
      yield* manager.drain;
      expect(
        (yield* manager.snapshot).sources.find((entry) => entry.id === "community")?.health?.detail,
      ).toContain("node:stream/promises");
      yield* manager.mutate({
        type: "install",
        sourceId: "community",
        locator: source,
        skill: "",
        targetIds: [],
      });
      yield* manager.drain;
      const snapshot = yield* (yield* restart).snapshot;
      const skill = snapshot.skills[0]!;
      expect(skill.failureDiagnostics).toContain("node:stream/promises");
      expect(snapshot.lastFailureDiagnostics).toBe(skill.failureDiagnostics);
      expect(snapshot.jobs?.at(-1)?.diagnostics).toBe(skill.failureDiagnostics);
      yield* fs.writeFileString(
        executable,
        '#!/usr/bin/env node\nimport { mkdirSync, cpSync } from "node:fs";\nmkdirSync(".agents/skills", { recursive: true });\ncpSync(process.argv[3], ".agents/skills/review", { recursive: true });\n',
      );
      yield* manager.mutate({ type: "check", id: skill.id });
      yield* manager.drain;
      const retried = yield* manager.snapshot;
      expect(retried.skills[0]?.failure).toBeNull();
      expect(retried.skills[0]?.failureDiagnostics).toBeNull();
      expect(retried.lastFailureDiagnostics).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

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
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("backs up conflicting directories and defers activation while agents are busy", () =>
    Effect.gen(function* () {
      const { fs, source, target, manager, install, busy, restart } = yield* harness;
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
      const linked = (yield* manager.snapshot).skills[0]!;
      expect(linked.bindings[0]?.status).toBe("linked");
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      expect(yield* fs.readFileString(`${linked.backups![0]!.backup}/SKILL.md`)).toBe("original");
      yield* fs.remove(`${target}/review`);
      yield* fs.writeFileString(`${target}/review`, "another original");
      yield* manager.mutate({
        type: "configure",
        id: pending.id,
        policy: "manual",
        targetIds: ["fixture"],
      });
      yield* manager.drain;
      const configured = (yield* manager.snapshot).skills[0]!;
      expect(configured.bindings[0]?.status).toBe("linked");
      expect(configured.backups).toHaveLength(2);
      expect(yield* fs.readFileString(configured.backups![1]!.backup)).toBe("another original");
      yield* fs.remove(`${target}/review`);
      yield* fs.copy(source, `${target}/review`);
      yield* fs.writeFileString(`${source}/script.sh`, "second");
      yield* manager.mutate({ type: "update", id: pending.id });
      yield* manager.drain;
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("second");
      const recovered = yield* restart;
      expect((yield* recovered.snapshot).skills[0]?.backups).toHaveLength(3);
      yield* recovered.mutate({ type: "unmanage", id: pending.id, restore: true });
      yield* recovered.drain;
      expect((yield* recovered.snapshot).skills).toHaveLength(0);
      expect(yield* fs.readFileString(`${target}/review/SKILL.md`)).toBe("original");
      expect(yield* fs.readFileString(configured.backups![1]!.backup)).toBe("another original");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("keeps original files when backing up or linking fails and retries the binding", () =>
    Effect.gen(function* () {
      const { fs, source, target, restart, restartWithFileSystem } = yield* harness;
      for (const method of ["rename", "symlink"] as const) {
        yield* fs.makeDirectory(`${target}/review`, { recursive: true });
        yield* fs.writeFileString(`${target}/review/original.txt`, method);
        const originalPath = yield* fs.realPath(`${target}/review`);
        const failing = yield* restartWithFileSystem({
          ...fs,
          [method]: (from: string, to: string) =>
            (method === "rename" ? from : to) === originalPath
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method,
                  }),
                )
              : fs[method](from, to),
        });
        yield* failing.mutate({
          type: "install",
          sourceId: "local",
          locator: source,
          skill: "",
          targetIds: ["fixture"],
        });
        yield* failing.drain;
        expect(yield* fs.readFileString(`${target}/review/original.txt`)).toBe(method);
        expect((yield* failing.snapshot).skills[0]?.bindings[0]?.status).toBe("missing");
        const failed = (yield* failing.snapshot).skills[0]!;
        if (method === "rename") {
          yield* failing.mutate({
            type: "configure",
            id: failed.id,
            policy: failed.policy,
            targetIds: [],
          });
          yield* failing.drain;
          expect((yield* failing.snapshot).skills[0]?.bindings).toEqual([]);
          expect(yield* fs.readFileString(`${target}/review/original.txt`)).toBe(method);
        }
        const recovered = yield* restart;
        if (method === "rename") {
          yield* recovered.mutate({
            type: "configure",
            id: failed.id,
            policy: failed.policy,
            targetIds: ["fixture"],
          });
          yield* recovered.drain;
        }
        const skill = (yield* recovered.snapshot).skills[0]!;
        expect(skill.status).toBe("ready");
        expect(skill.failureReason).toBeNull();
        expect(skill.bindings[0]?.status).toBe("linked");
        expect(yield* fs.readFileString(`${skill.backups![0]!.backup}/original.txt`)).toBe(method);
        yield* recovered.mutate({ type: "remove", id: skill.id });
        yield* recovered.drain;
        expect(yield* fs.readFileString(`${target}/review/original.txt`)).toBe(method);
        yield* fs.remove(`${target}/review`, { recursive: true });
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "recovers a committed version switch without fetching and guards referenced sources and targets",
    () =>
      Effect.gen(function* () {
        const { fs, directory, source, target, manager, install, restart, sql } = yield* harness;
        yield* install;
        yield* fs.writeFileString(`${source}/script.sh`, "second");
        const first = (yield* manager.snapshot).skills[0]!;
        yield* manager.mutate({ type: "check", id: first.id });
        yield* manager.drain;
        const catalog = yield* manager.snapshot;
        const checked = catalog.skills[0]!;
        const working = yield* fs.realPath(`${target}/review`);
        yield* fs.copy(source, working.replace(/[^/\\]+$/, "prepared"));
        const original = `${checked.bindings[0]!.directory}/review`;
        const backup = `${directory}/interrupted-backup`;
        yield* fs.remove(original);
        yield* fs.makeDirectory(original);
        yield* fs.writeFileString(`${original}/original.txt`, "interrupted original");
        yield* fs.rename(original, backup);
        const payload = yield* encodeCatalog({
          ...catalog,
          skills: [
            {
              ...checked,
              backups: [{ original, backup }],
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
        yield* recovered.mutate({ type: "remove", id: first.id });
        yield* recovered.drain;
        expect(yield* fs.readFileString(`${target}/review/original.txt`)).toBe(
          "interrupted original",
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
      yield* fs.remove(`${source}/outside`);
      yield* fs.copy(source, `${directory}/external-skill`);
      yield* fs.symlink(`${directory}/external-skill`, `${source}/external`);
      yield* manager.mutate({
        type: "install",
        sourceId: "local",
        locator: source,
        skill: "external",
        targetIds: [],
      });
      yield* manager.drain;
      const escaped = (yield* manager.snapshot).skills.at(-1)!;
      expect(escaped.failureReason).toBe("invalid-package");
      expect(escaped.activeDigest).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
  it.effect("deduplicates physical discoveries, previews and restores a taken-over directory", () =>
    Effect.gen(function* () {
      const { fs, source, target, manager, install, restart, sql } = yield* harness;
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.copy(source, `${target}/review`);
      yield* fs.writeFileString(
        `${target}/review/SKILL.md`,
        "---\nname: review-skill\ndescription: Review a change\n---\n",
      );
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
      const refreshed = yield* manager.snapshot;
      expect(new Set(refreshed.targets.map((entry) => entry.directory)).size).toBe(1);
      const discovered = refreshed.discovered;
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.targetIds).toHaveLength(2);
      expect(discovered[0]?.origin?.locator).toBe("review-package");
      const preview = yield* manager.inspect({ type: "adopt", path: `${target}/review` });
      yield* manager.mutate({
        type: "adopt",
        path: `${target}/review`,
        digest: preview.digest,
        mode: "copy",
        targetIds: [],
      });
      yield* manager.drain;
      const copied = (yield* manager.snapshot).skills[0]!;
      expect(copied.bindings).toHaveLength(0);
      yield* fs.remove(`${target}/.mtskills-source.jsonl`);
      yield* fs.writeFileString(`${target}/review/script.sh`, "local change");
      const changed = yield* manager.inspect({ type: "adopt", path: `${target}/review` });
      yield* manager.mutate({
        type: "adopt",
        path: `${target}/review`,
        digest: changed.digest,
        mode: "takeover",
        targetIds: ["fixture"],
      });
      yield* manager.drain;
      expect((yield* manager.snapshot).lastFailureReason).toBe("candidate-changed");
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("local change");
      yield* fs.writeFileString(`${target}/review/script.sh`, "first");
      const duplicate = `${target}/../duplicate`;
      yield* fs.makeDirectory(duplicate);
      yield* fs.copy(`${target}/review`, `${duplicate}/review-skill`);
      yield* manager.mutate({
        type: "target.save",
        target: { id: "duplicate", label: "Duplicate", directory: duplicate },
      });
      yield* manager.drain;
      yield* fs.writeFileString(`${duplicate}/review-skill/script.sh`, "different");
      yield* manager.mutate({
        type: "adopt",
        path: `${target}/review`,
        digest: preview.digest,
        mode: "takeover",
        targetIds: ["fixture", "duplicate"],
      });
      yield* manager.drain;
      expect((yield* manager.snapshot).lastFailureReason).toBe("conflict");
      expect(yield* fs.readFileString(`${duplicate}/review-skill/script.sh`)).toBe("different");
      yield* fs.writeFileString(`${duplicate}/review-skill/script.sh`, "first");
      yield* manager.mutate({
        type: "adopt",
        path: `${target}/review`,
        digest: preview.digest,
        mode: "takeover",
        targetIds: ["fixture", "alias", "duplicate"],
      });
      yield* manager.drain;
      const adopted = (yield* manager.snapshot).skills[0]!;
      expect((yield* manager.snapshot).skills).toHaveLength(1);
      expect(adopted.id).toBe(copied.id);
      expect(adopted.bindings).toHaveLength(2);
      expect(yield* fs.readLink(`${duplicate}/review-skill`)).toBe(
        yield* fs.readLink(`${target}/review`),
      );
      expect((yield* manager.snapshot).discovered).toHaveLength(0);
      expect(adopted.policy).toBe("automatic");
      expect((yield* manager.snapshot).jobs?.at(-1)).toMatchObject({
        skillId: copied.id,
        status: "completed",
        afterDigest: copied.activeDigest,
      });
      expect(adopted.sourceId).toBe("meituan");
      expect(adopted.locator).toBe("review-package");
      expect(adopted.snapshotOnly).toBe(false);
      expect(adopted.backups).toHaveLength(2);
      yield* manager.mutate({
        type: "configure",
        id: adopted.id,
        policy: adopted.policy,
        targetIds: ["alias"],
      });
      yield* manager.drain;
      expect((yield* manager.snapshot).skills[0]?.bindings[0]?.entryName).toBe("review");
      expect(yield* fs.exists(`${target}/review-skill`)).toBe(false);
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      yield* manager.mutate({ type: "unmanage", id: adopted.id, restore: true });
      yield* manager.drain;
      expect((yield* manager.snapshot).skills).toHaveLength(0);
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      expect((yield* fs.stat(`${target}/review`)).type).toBe("Directory");
      expect((yield* fs.stat(`${duplicate}/review-skill`)).type).toBe("Directory");
      expect(yield* fs.readFileString(`${duplicate}/review-skill/script.sh`)).toBe("first");
      yield* manager.mutate({
        type: "adopt",
        path: `${target}/review`,
        digest: preview.digest,
        mode: "takeover",
        targetIds: ["fixture", "duplicate"],
      });
      yield* manager.drain;
      const direct = (yield* manager.snapshot).skills[0]!;
      expect(direct.adoptionState).toBe("complete");
      expect(direct.backups).toHaveLength(2);
      expect(direct.bindings.every((binding) => binding.status === "linked")).toBe(true);
      expect(yield* fs.readLink(`${duplicate}/review-skill`)).toBe(
        yield* fs.readLink(`${target}/review`),
      );
      yield* manager.mutate({
        type: "adopt",
        path: `${duplicate}/review-skill`,
        digest: preview.digest,
        mode: "takeover",
        targetIds: ["duplicate"],
      });
      yield* manager.drain;
      expect((yield* manager.snapshot).lastFailureReason).toBe("conflict");
      expect((yield* manager.snapshot).skills).toHaveLength(1);
      yield* manager.mutate({ type: "unmanage", id: direct.id, restore: true });
      yield* manager.drain;
      expect((yield* fs.stat(`${target}/review`)).type).toBe("Directory");
      expect((yield* fs.stat(`${duplicate}/review-skill`)).type).toBe("Directory");
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "waits to take over skills, survives restart, and revalidates before replacing files",
    () =>
      Effect.gen(function* () {
        const { fs, source, target, manager, busy, restart, restartWithFileSystem } =
          yield* harness;
        yield* fs.makeDirectory(target, { recursive: true });
        yield* fs.copy(source, `${target}/review`);
        const preview = yield* manager.inspect({ type: "adopt", path: `${target}/review` });
        const input = {
          type: "adopt" as const,
          path: `${target}/review`,
          digest: preview.digest,
          mode: "takeover" as const,
          targetIds: ["fixture"],
        };
        yield* Ref.set(busy, true);
        yield* manager.mutate(input);
        yield* manager.drain;
        const waiting = yield* manager.snapshot;
        expect(waiting.lastFailureReason).toBeNull();
        expect(waiting.jobs?.at(-1)).toMatchObject({ status: "waiting", finishedAt: null });
        expect(waiting.skills).toHaveLength(0);
        expect((yield* fs.stat(`${target}/review`)).type).toBe("Directory");
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
        yield* manager.mutate(input);
        yield* manager.drain;
        expect((yield* manager.snapshot).jobs).toHaveLength(1);
        const recovered = yield* restart;
        yield* recovered.drain;
        expect((yield* recovered.snapshot).jobs?.at(-1)?.status).toBe("waiting");
        yield* fs.writeFileString(`${target}/review/script.sh`, "changed while waiting");
        yield* Ref.set(busy, false);
        yield* recovered.tick;
        yield* recovered.drain;
        expect((yield* recovered.snapshot).jobs?.at(-1)).toMatchObject({
          status: "failed",
          reason: "candidate-changed",
        });
        expect((yield* recovered.snapshot).skills).toHaveLength(0);
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe(
          "changed while waiting",
        );
        yield* fs.writeFileString(`${target}/review/script.sh`, "first");
        yield* Ref.set(busy, true);
        yield* recovered.mutate(input);
        yield* recovered.drain;
        const cancelledId = (yield* recovered.snapshot).jobs!.at(-1)!.id;
        yield* recovered.mutate({ type: "cancel", id: cancelledId });
        yield* recovered.drain;
        expect((yield* recovered.snapshot).jobs?.at(-1)).toMatchObject({
          id: cancelledId,
          status: "cancelled",
        });
        yield* Ref.set(busy, false);
        yield* recovered.tick;
        yield* recovered.drain;
        expect((yield* recovered.snapshot).skills).toHaveLength(0);
        expect((yield* fs.stat(`${target}/review`)).type).toBe("Directory");
        yield* Ref.set(busy, true);
        yield* recovered.mutate(input);
        yield* recovered.drain;
        const waitingId = (yield* recovered.snapshot).jobs!.at(-1)!.id;
        yield* Ref.set(busy, false);
        yield* recovered.tick;
        yield* recovered.drain;
        const completed = yield* recovered.snapshot;
        expect(completed.jobs?.at(-1)).toMatchObject({ id: waitingId, status: "completed" });
        expect(completed.skills[0]?.adoptionState).toBe("complete");
        expect(completed.skills[0]?.backups).toHaveLength(1);
        expect(yield* fs.readLink(`${target}/review`)).toBeTruthy();
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
        yield* recovered.mutate({ type: "cancel", id: completed.skills[0]!.id });
        yield* recovered.drain;
        expect((yield* recovered.snapshot).jobs?.at(-1)).toMatchObject({
          input: { type: "cancel", id: completed.skills[0]!.id },
          status: "completed",
        });
        yield* recovered.mutate({ type: "unmanage", id: completed.skills[0]!.id, restore: true });
        yield* recovered.drain;
        const interruptBackup = yield* Ref.make(true);
        const originalPath = yield* fs.realPath(`${target}/review`);
        const racing = yield* restartWithFileSystem({
          ...fs,
          rename: (from, to) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.tap(() =>
                  from === originalPath
                    ? Ref.getAndSet(interruptBackup, false).pipe(
                        Effect.flatMap((interrupt) =>
                          interrupt ? Ref.set(busy, true) : Effect.void,
                        ),
                      )
                    : Effect.void,
                ),
              ),
        });
        yield* racing.mutate(input);
        yield* racing.drain;
        expect((yield* racing.snapshot).jobs?.at(-1)?.status).toBe("waiting");
        expect((yield* racing.snapshot).skills).toHaveLength(0);
        expect((yield* fs.stat(`${target}/review`)).type).toBe("Directory");
        expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
        yield* Ref.set(busy, false);
        yield* racing.tick;
        yield* racing.drain;
        expect((yield* racing.snapshot).jobs?.at(-1)?.status).toBe("completed");
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not replace a location owned by another managed skill", () =>
    Effect.gen(function* () {
      const { fs, directory, source, target, manager, install, restart } = yield* harness;
      yield* install;
      const first = (yield* manager.snapshot).skills[0]!;
      yield* fs.copy(source, `${directory}/other-source`);
      yield* fs.writeFileString(`${directory}/other-source/script.sh`, "other skill");
      yield* manager.mutate({
        type: "install",
        sourceId: "local",
        locator: `${directory}/other-source`,
        skill: "",
        targetIds: ["fixture"],
      });
      yield* manager.drain;
      const second = (yield* manager.snapshot).skills.find((skill) => skill.id !== first.id)!;
      expect(second.bindings[0]?.status).toBe("conflict");
      expect(second.backups ?? []).toEqual([]);
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      const recovered = yield* restart;
      expect(
        (yield* recovered.snapshot).skills.find((skill) => skill.id === second.id)?.bindings[0]
          ?.status,
      ).toBe("conflict");
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
      yield* recovered.mutate({ type: "remove", id: second.id });
      yield* recovered.drain;
      expect((yield* recovered.snapshot).skills.map((skill) => skill.id)).toEqual([first.id]);
      expect(yield* fs.readFileString(`${target}/review/script.sh`)).toBe("first");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
        for (const policy of ["manual", "pinned", "notify", "automatic"] as const) {
          yield* manager.mutate({ type: "policy", id: skill.id, policy });
          yield* manager.drain;
          const current = (yield* manager.snapshot).skills[0]!;
          expect(current.failureReason).toBe(
            policy === "manual" || policy === "pinned" ? null : "needs-source",
          );
          expect(current.status).toBe("ready");
          expect(current.failure).toBeNull();
        }
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
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
  it.effect("replays durable queued jobs once and exposes multiple skill choices", () =>
    Effect.gen(function* () {
      const { fs, directory, source, manager, restart, sql } = yield* harness;
      const packageRoot = `${directory}/multi`;
      yield* fs.makeDirectory(packageRoot);
      yield* fs.copy(source, `${packageRoot}/one`);
      yield* fs.copy(source, `${packageRoot}/two`);
      yield* fs.writeFileString(
        `${packageRoot}/SKILL.md`,
        "---\nname: suite\ndescription: Team suite\n---\n",
      );
      yield* fs.makeDirectory(`${packageRoot}/templates`);
      yield* fs.writeFileString(
        `${packageRoot}/templates/SKILL.md`,
        "Skill template without metadata",
      );
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
      expect(failed.choices).toEqual(["suite", "review", "second"]);
      yield* manager.mutate({
        type: "configure",
        id: failed.id,
        policy: failed.policy,
        targetIds: ["fixture"],
      });
      yield* manager.drain;
      const configured = (yield* manager.snapshot).skills[0]!;
      expect(configured.failureReason).toBe("select-skill");
      expect(configured.status).toBe("failed");
      expect(configured.bindings.map((target) => target.id)).toEqual(["fixture"]);
      const payload = yield* encodeCatalog({
        ...(yield* manager.snapshot),
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
      yield* recovered.mutate(
        skillSelection((yield* recovered.snapshot).skills[0]!, ["second", "review"]),
      );
      yield* recovered.drain;
      expect(
        (yield* recovered.snapshot).skills.map((entry) => [entry.name, entry.status]).sort(),
      ).toEqual([
        ["review", "ready"],
        ["second", "ready"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
