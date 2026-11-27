import * as NodeModule from "node:module";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export class NodePtyModuleLoadError extends Schema.TaggedError<
  NodePtyModuleLoadError,
  { readonly brand: unique symbol }
>()("NodePtyModuleLoadError", {
  platform: Schema.String,
  architecture: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

// node-pty's native addon stays external; single-executables need require to resolve disk modules and spawn helpers.
const requireForNodePty = NodeModule.createRequire(import.meta.url);

const loadNodePty: NodePtyModuleLoader = () =>
  Promise.resolve().then(() => requireForNodePty("node-pty") as typeof import("node-pty"));

export const NodePtyModuleLoaderRef = Context.Reference<NodePtyModuleLoader>(
  "server/terminal/NodePtyModuleLoader",
  { defaultValue: () => loadNodePty },
);

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (helperPath && (yield* fs.exists(helperPath))) {
    yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
  }
  // Set only after the repair finishes, so a check cut off by the spawn deadline runs again.
  didEnsureSpawnHelperExecutable = true;
});

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly exitSubscription: import("node-pty").IDisposable;

  constructor(process: import("node-pty").IPty) {
    this.process = process;
    this.exitSubscription = process.onExit((event) => {
      if (this.exitEvent) return;
      this.exitEvent = { exitCode: event.exitCode, signal: event.signal ?? null };
      this.exitSubscription.dispose();
      for (const listener of this.exitListeners) listener(this.exitEvent);
      this.exitListeners.clear();
    });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string | Buffer): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }
}

const make = Effect.fn("NodePtyAdapter.make")(function* () {
  const loadNodePtyModule = yield* NodePtyModuleLoaderRef;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureSpawnHelperExecutable = ensureNodePtySpawnHelperExecutable().pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Architecture, architecture),
    Effect.orElseSucceed(() => undefined),
    // Terminal startup runs uninterruptibly; a stalled helper check must not hold its locks.
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureSpawnHelperExecutable;
      return yield* Effect.try({
        try: () => {
          const nativeProcess = nodePty.spawn(input.shell, input.args ?? [], {
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env: input.env,
            name: "xterm-256color",
          });
          return new NodePtyProcess(nativeProcess);
        },
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
