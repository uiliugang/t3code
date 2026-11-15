// @effect-diagnostics nodeBuiltinImport:off - Lean CLI boundary preserves native terminal descriptors and signals.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Framing from "../provider/CodexManagedTokenProtocol.ts";
import * as Protocol from "../provider/nativeCliProtocol.ts";
import { isNativeCliCredential, parseNativeCliArguments } from "../provider/nativeCliLaunch.ts";

export async function runNativeCli(argv: ReadonlyArray<string>) {
  const [stateDir, command, ...input] = argv;
  let socket: NodeNet.Socket | undefined;
  try {
    if (!stateDir || (command !== "codex" && command !== "claude"))
      throw new Error("Invalid T3 terminal command.");
    const { instanceId, args } = parseNativeCliArguments(input);
    const threadId = process.env.T3CODE_PROVIDER_THREAD_ID ?? process.env.T3CODE_THREAD_ID;
    const descriptor = NodePath.join(stateDir, Protocol.DESCRIPTOR);
    const stat = await NodeFSP.lstat(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("The T3 terminal endpoint is not private.");
    const endpoint = await NodeFSP.readFile(descriptor, "utf8");
    const parent = await NodeFSP.lstat(NodePath.dirname(endpoint));
    if (!parent.isDirectory() || parent.uid !== stat.uid || (parent.mode & 0o077) !== 0)
      throw new Error("The T3 terminal endpoint is not private.");
    socket = NodeNet.createConnection(endpoint);
    socket.on("error", () => {});
    const frame = JSON.stringify({
      command,
      args,
      ...(threadId ? { threadId } : {}),
      ...((instanceId ?? process.env.T3CODE_PROVIDER_INSTANCE_ID)
        ? { instanceId: instanceId ?? process.env.T3CODE_PROVIDER_INSTANCE_ID }
        : {}),
    });
    if (Buffer.byteLength(frame) > Protocol.FRAME_BYTES)
      throw new Error("T3 terminal arguments are too large.");
    socket.write(`${frame}\n`);
    const response = await Effect.runPromise(
      Framing.readFrame(socket, Protocol.FRAME_BYTES, Protocol.TIMEOUT_MS + 1000).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Protocol.Response))),
      ),
    );
    if (!response.ok) {
      process.stderr.write(`${response.message}\n`);
      process.exitCode = 1;
      return;
    }
    const environment = { ...process.env };
    for (const key of Object.keys(environment))
      if (isNativeCliCredential(key)) delete environment[key];
    for (const [key, value] of Object.entries(response.environment)) {
      if (value === null) delete environment[key];
      else environment[key] = value;
    }
    for (const key of [
      "TERM",
      "COLORTERM",
      "TERM_PROGRAM",
      "TERM_PROGRAM_VERSION",
      "PWD",
      "SHLVL",
      "T3CODE_THREAD_ID",
      "T3CODE_PROVIDER_INSTANCE_ID",
    ])
      if (process.env[key] !== undefined) environment[key] = process.env[key];
      else delete environment[key];
    const child = NodeChildProcess.spawn(response.command, [...response.args], {
      stdio: "inherit",
      env: environment,
    });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    for (const signal of signals) process.on(signal, forward);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          resolve(code ?? 128 + (signal ? NodeOS.constants.signals[signal] : 1)),
        );
      });
    } finally {
      for (const signal of signals) process.off(signal, forward);
    }
  } catch {
    process.stderr.write(
      "Could not start the T3 terminal provider. Start the matching T3 Code server and check its provider settings.\n",
    );
    process.exitCode = 1;
  } finally {
    socket?.destroy();
  }
}
