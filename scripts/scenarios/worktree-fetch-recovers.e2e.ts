// @effect-diagnostics nodeBuiltinImport:off - the fixture needs a raw HTTP server to drop the Git connection before sending headers.
import * as NodeHttp from "node:http";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeLaunched = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);

test(
  "A worktree launch recovers from a dropped Git connection without resending the task",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("fetch-recovery");
    const remote = `${project}/remote.git`;
    await runPromise(run("git", ["clone", "--bare", project, remote], { cwd: project }));
    await runPromise(run("git", ["update-server-info"], { cwd: remote }));
    let failed = false;
    const server = NodeHttp.createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (!failed && pathname === "/info/refs") {
        failed = true;
        request.socket.destroy();
        return;
      }
      if (!/^\/(?:info\/refs|HEAD|objects\/(?:info\/packs|[a-f0-9/]+))$/.test(pathname)) {
        response.writeHead(404).end();
        return;
      }
      void runPromise(
        Effect.gen(function* () {
          return yield* (yield* FileSystem.FileSystem).readFile(`${remote}${pathname}`);
        }),
      ).then(
        (data) => {
          response.setHeader("content-type", "text/plain");
          response.end(data);
        },
        () => {
          response.writeHead(404).end();
        },
      );
    });
    using _server = {
      [Symbol.dispose]() {
        server.closeAllConnections();
        server.close();
      },
    };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing Git fixture port");
    await runPromise(
      run("git", ["remote", "add", "origin", `http://127.0.0.1:${address.port}`], { cwd: project }),
    );
    const launched = await runPromise(
      run(
        process.execPath,
        [
          "apps/server/src/bin.ts",
          "thread",
          "start",
          project,
          "Start after reconnecting",
          "--worktree",
          "main",
          "--branch",
          "fetch-recovery",
          "--provider",
          "devReplay",
          "--model",
          "multi-turn",
          "--json",
          "--base-dir",
          T3_HOME,
        ],
        { cwd: APP_DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      ).pipe(Effect.flatMap(({ stdout }) => decodeLaunched(stdout))),
    );
    await t3.open(launched);
    try {
      await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    } finally {
      await app.screenshot("fetch-recovery");
    }
  },
);
