// @effect-diagnostics nodeBuiltinImport:off - Private local Unix socket and atomic descriptor publication.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as NativeCli from "./NativeCli.ts";
import * as Framing from "./CodexManagedTokenProtocol.ts";
import * as Protocol from "./nativeCliProtocol.ts";

import * as HostProcess from "@t3tools/shared/HostProcess";

const isNativeCliError = Schema.is(NativeCli.NativeCliError);
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Protocol.Request));
const encode = Schema.encodeSync(Schema.fromJsonString(Protocol.Response));

const start = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) === "win32") return;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const cli = yield* NativeCli.NativeCli;
  const temporaryDirectory = (yield* HostProcess.Environment).TMPDIR ?? NodeOS.tmpdir();
  const directory = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const candidate = await NodeFSP.mkdtemp(NodePath.join(temporaryDirectory, "t3-cli-"));
      if (Buffer.byteLength(NodePath.join(candidate, "s")) <= 100) return candidate;
      await NodeFSP.rmdir(candidate);
      return NodeFSP.mkdtemp("/tmp/t3-cli-");
    }),
    (directory) => Effect.promise(() => NodeFSP.rmdir(directory).catch(() => {})),
  );
  yield* Effect.promise(() => NodeFSP.chmod(directory, 0o700));
  const endpoint = NodePath.join(directory, "s");
  const descriptor = NodePath.join(stateDir, Protocol.DESCRIPTOR);
  const run = yield* FiberSet.makeRuntime<never, void>();
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const closed = Effect.callback<void>((resume) => {
      if (socket.destroyed) {
        resume(Effect.void);
        return;
      }
      const onClose = () => resume(Effect.void);
      socket.once("close", onClose);
      return Effect.sync(() => socket.off("close", onClose));
    });
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const request = yield* Framing.readFrame(socket, Protocol.FRAME_BYTES, 5_000).pipe(
            Effect.flatMap(decode),
          );
          const result = yield* cli.resolve(request).pipe(
            Effect.timeout(Protocol.TIMEOUT_MS),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false as const,
                message: isNativeCliError(error)
                  ? error.message
                  : "T3 provider preparation timed out. Retry in a moment.",
              }),
            ),
          );
          const frame = encode(result);
          if (Buffer.byteLength(frame) > Protocol.FRAME_BYTES) return;
          yield* Effect.callback<void>((resume) => {
            socket.write(`${frame}\n`, () => resume(Effect.void));
          });
          // Keep installation leases alive until the native child releases this connection.
          if (result.ok) yield* closed;
        }),
      ).pipe(
        Effect.raceFirst(closed),
        Effect.ignoreCause,
        Effect.ensuring(Effect.sync(() => socket.destroy())),
      ),
    );
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const saved = await NodeFSP.readFile(descriptor, "utf8").catch(() => "");
      if (saved === endpoint) await NodeFSP.unlink(descriptor).catch(() => {});
    }),
  );
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      }),
  );
  server.on("error", () => {});
  yield* Effect.promise(async () => {
    await NodeFSP.chmod(endpoint, 0o600);
    const staging = `${descriptor}.${process.pid}`;
    await NodeFSP.writeFile(staging, endpoint, { mode: 0o600 });
    await NodeFSP.rename(staging, descriptor);
  });
});

export const layer = Layer.effectDiscard(start);
