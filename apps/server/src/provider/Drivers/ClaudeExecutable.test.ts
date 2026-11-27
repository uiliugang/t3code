// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";

import { claudeProgramReader, claudeProgramWasReplaced } from "./ClaudeExecutable.ts";

describe("claudeProgramReader", () => {
  /** An install as the Claude installer lays it out: one file per version and a link. */
  const makeInstall = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-program-" });
    const bin = NodePath.join(root, "bin");
    const link = NodePath.join(bin, "claude");
    const version = (name: string) => {
      const file = NodePath.join(root, "versions", name);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
      return file;
    };
    NodeFS.mkdirSync(bin);
    NodeFS.symlinkSync(version("1.0.0"), link);
    return {
      bin,
      update: () => {
        NodeFS.unlinkSync(link);
        NodeFS.symlinkSync(version("1.0.1"), link);
      },
    };
  });

  it.effect("follows a bare command name through PATH", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bin, update } = yield* makeInstall;
        const readProgram = yield* claudeProgramReader("claude", { PATH: bin });
        const startedFrom = yield* readProgram;
        expect(startedFrom).toBeDefined();
        expect(claudeProgramWasReplaced(startedFrom, yield* readProgram)).toBe(false);
        update();
        expect(claudeProgramWasReplaced(startedFrom, yield* readProgram)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
