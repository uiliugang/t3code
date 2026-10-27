import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveMCodeCommand } from "./MCodeRuntime.ts";

it.effect.each([
  ["auth", "status"],
  ["repo", "list"],
])("runs code-cli with fetch even when PATH has an old Node: %s", (args) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const windows = (yield* HostProcess.Platform) === "win32";
    const oldNode = path.join(cwd, windows ? "node.cmd" : "node");
    yield* fs.writeFileString(
      oldNode,
      windows ? "@echo off\r\necho offline\r\n" : "#!/bin/sh\necho offline\n",
    );
    yield* fs.chmod(oldNode, 0o755);
    const entry = windows
      ? path.join(cwd, "node_modules/@ee/code-cli/dist/main.js")
      : path.join(cwd, "code-cli");
    yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
    if (windows)
      yield* fs.writeFileString(
        path.join(cwd, "code-cli.cmd"),
        '@echo off\r\n@"%~dp0node.cmd" %*\r\n',
      );
    yield* fs.writeFileString(
      entry,
      '#!/usr/bin/env node\nconsole.log(typeof fetch === "function" ? "verified" : "offline");\n',
    );
    yield* fs.chmod(entry, 0o755);
    const input = {
      operation: "test.mcode",
      command: "code-cli",
      args,
      cwd,
      env: { PATH: cwd, ...(windows ? { PATHEXT: ".CMD" } : {}) },
    };
    const process = yield* VcsProcess.VcsProcess;
    expect((yield* process.run(input)).stdout.trim()).toBe("offline");
    const resolved = yield* resolveMCodeCommand(input).pipe(
      Effect.provideService(HostProcess.IsExecutable, false),
    );
    expect((yield* process.run(resolved)).stdout.trim()).toBe("verified");
  }).pipe(
    Effect.scoped,
    Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
