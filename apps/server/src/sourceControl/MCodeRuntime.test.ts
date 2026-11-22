import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeResolveMCodeCommand } from "./MCodeRuntime.ts";

it.effect.each([
  { command: "code-cli", args: ["auth", "status"] },
  { command: "code-cli", args: ["repo", "list"] },
  { command: "ones2", args: ["workitem", "list"] },
  { command: "mcm", args: ["user", "my"] },
])("runs $command with fetch even when PATH has an old Node: $args", ({ command, args }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const windows = (yield* HostProcess.Platform) === "win32";
    const bin = path.join(cwd, "bin");
    yield* fs.makeDirectory(bin);
    const oldNode = path.join(bin, windows ? "node.cmd" : "node");
    yield* fs.writeFileString(
      oldNode,
      windows ? "@echo off\r\necho offline\r\n" : "#!/bin/sh\necho offline\n",
    );
    yield* fs.chmod(oldNode, 0o755);
    const input = {
      operation: "test.mcode",
      command,
      args,
      cwd,
      env: { PATH: bin, ...(windows ? { PATHEXT: ".EXE;.CMD" } : {}) },
    };
    const resolveMCodeCommand = yield* makeResolveMCodeCommand;
    if (command !== "code-cli") expect(yield* resolveMCodeCommand(input)).toBe(input);
    const entry = windows
      ? path.join(bin, `node_modules/@ee/${command}/dist/main.js`)
      : path.join(bin, command);
    yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
    if (windows)
      yield* fs.writeFileString(
        path.join(bin, `${command}.cmd`),
        `@echo off\r\n@node "%~dp0node_modules/@ee/${command}/dist/main.js" %*\r\n`,
      );
    yield* fs.writeFileString(
      entry,
      '#!/usr/bin/env node\nconsole.log(typeof fetch === "function" ? "verified" : "offline");\n',
    );
    yield* fs.chmod(entry, 0o755);
    const process = yield* VcsProcess.VcsProcess;
    expect((yield* process.run(input)).stdout.trim()).toBe("offline");
    const resolved = yield* resolveMCodeCommand(input).pipe(
      Effect.provideService(HostProcess.IsExecutable, false),
    );
    expect((yield* process.run(resolved)).stdout.trim()).toBe("verified");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      VcsProcess.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
