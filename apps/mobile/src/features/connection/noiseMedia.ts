import { openLocalMediaOrigins } from "@t3tools/client-runtime/connection";
import type { ClientCapabilities } from "@t3tools/client-runtime/platform";
import type { LocalNoiseMediaListener } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

// WebView's host-localhost proxy is process-wide; keep every active app media port local.
let activePorts: readonly number[] = [];
const subscribers = new Set<() => void>();
const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
};
const currentPorts = () => activePorts;
const updatePorts = (ports: readonly number[]) => {
  activePorts = ports;
  for (const notify of subscribers) notify();
};
export const useNoiseMediaPorts = () => useSyncExternalStore(subscribe, currentPorts);

export const openAndroidMediaOrigins = Effect.fn("mobile.connectNoise.openMediaOrigins")(function* <
  E,
>(open: Effect.Effect<ClientCapabilities.ApprovedNoiseConnection, E, Scope.Scope>) {
  const origins = yield* openLocalMediaOrigins(async () => {
    const { requireNativeModule } = await import("expo");
    return new (requireNativeModule<{ NoiseMediaListener: new () => LocalNoiseMediaListener }>(
      "T3NativeControls",
    ).NoiseMediaListener)();
  }, open);
  if (origins) {
    const port = Number(new URL(origins.asset).port);
    yield* Effect.acquireRelease(
      Effect.sync(() => updatePorts([...activePorts, port])),
      () => Effect.sync(() => updatePorts(activePorts.filter((active) => active !== port))),
    );
  }
  return origins;
});
