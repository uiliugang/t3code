import { EMPTY_CONNECTION_CATALOG_DOCUMENT } from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Storage from "../persistence/mobile-secure-storage";
import { readNoiseAgentActivity } from "./agentActivityWake";

const mocks = vi.hoisted(() => ({
  storage: vi.fn(),
  pin: vi.fn(),
  open: vi.fn(),
  fetch: vi.fn(),
  preferences: vi.fn(),
  clerk: {
    loaded: false,
    load: vi.fn(),
    session: null as { id: string; user: { id: string }; getToken: () => Promise<string> } | null,
  },
}));

vi.mock("expo-secure-store", () => ({ getItemAsync: mocks.storage }));
vi.mock("../connection/catalog-store", () => ({ CONNECTION_CATALOG_KEY: "catalog" }));
vi.mock("../features/cloud/clerkInstance", () => ({ cloudClerk: mocks.clerk }));
vi.mock("../features/cloud/publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));
vi.mock("../rpc/agentActivity", () => ({ fetchNoiseAgentActivity: mocks.fetch }));
vi.mock("../features/agent-awareness/wakePreferences", () => ({
  readWakePreferences: mocks.preferences,
}));
vi.mock("../features/connection/noiseApproval", async () => {
  const { ClientCapabilities } = await import("@t3tools/client-runtime/platform");
  const Layer = await import("effect/Layer");
  return {
    layerNoiseConnections: Layer.mock(ClientCapabilities.NoiseConnections)({
      readPin: mocks.pin,
      open: mocks.open,
    }),
  };
});

const services = Layer.mergeAll(
  Storage.layer,
  Layer.mock(ManagedRelay.ManagedRelayClient)({ relayUrl: "https://relay.test" }),
  Layer.mock(ManagedRelay.ManagedRelayDpopSigner)({}),
  Layer.succeed(Socket.WebSocketConstructor, () => {
    throw new Error("Unexpected network connection");
  }),
);

function setup() {
  vi.resetAllMocks();
  const host = "qa-host";
  const user = "qa-user";
  const device = "qa-device";
  const catalog = {
    ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
    targets: [{ _tag: "RelayConnectionTarget", environmentId: host, label: "host" }],
  };
  const pin = new Uint8Array(32).fill(1);
  const session = { id: "session", user: { id: user }, getToken: vi.fn(async () => "token") };
  const preferences = { notificationsEnabled: true, liveActivitiesEnabled: false };
  const states = [{ environmentId: host }];
  mocks.clerk.loaded = false;
  mocks.clerk.session = null;
  mocks.clerk.load.mockImplementation(async () => {
    mocks.clerk.session = session;
    mocks.clerk.loaded = true;
  });
  mocks.storage.mockResolvedValue(JSON.stringify(catalog));
  mocks.pin.mockReturnValue(Effect.succeed(pin));
  mocks.preferences.mockReturnValue(Effect.succeed(preferences));
  mocks.open.mockReturnValue(Effect.succeed({}));
  mocks.fetch.mockReturnValue(Effect.succeed(states));
  return { host, user, device, catalog, pin, session, states, preferences };
}

it.effect("requires a saved and enabled relay target and its pin before loading the account", () =>
  Effect.gen(function* () {
    const { host, user, device, catalog } = setup();
    for (const stored of [
      null,
      "bad-json",
      JSON.stringify({ ...catalog, disabledEnvironmentIds: [host] }),
      JSON.stringify({ ...catalog, targets: [] }),
    ]) {
      mocks.storage.mockResolvedValueOnce(stored);
      expect(yield* Effect.isFailure(readNoiseAgentActivity(host, user, device))).toBe(true);
    }
    mocks.pin.mockReturnValueOnce(Effect.succeed(null));
    expect(yield* Effect.isFailure(readNoiseAgentActivity(host, user, device))).toBe(true);
    expect(mocks.clerk.load).not.toHaveBeenCalled();
    expect(mocks.preferences).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  }).pipe(Effect.provide(services)),
);

it.effect(
  "uses the restored account and checks the session, host key and returned environment before display",
  () =>
    Effect.gen(function* () {
      const { host, user, device, pin, session, states, preferences } = setup();
      const read = () => readNoiseAgentActivity(host, user, device);
      expect(yield* Effect.isFailure(readNoiseAgentActivity(host, "other-account", device))).toBe(
        true,
      );
      expect(session.getToken).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(yield* read()).toEqual({ states, preferences });
      expect(mocks.preferences).toHaveBeenCalledWith(host, device, "token");
      expect(mocks.open).toHaveBeenCalledWith(host, pin);
      expect(mocks.clerk.load).toHaveBeenCalledTimes(1);
      mocks.pin
        .mockReturnValueOnce(Effect.succeed(pin))
        .mockReturnValueOnce(Effect.succeed(new Uint8Array(32)));
      expect(yield* Effect.isFailure(read())).toBe(true);
      mocks.fetch.mockReturnValueOnce(Effect.succeed([{ environmentId: "other-host" }]));
      expect(yield* Effect.isFailure(read())).toBe(true);
      mocks.fetch.mockReturnValueOnce(
        Effect.sync(() => {
          mocks.clerk.session = null;
          return states;
        }),
      );
      expect(yield* Effect.isFailure(read())).toBe(true);
    }).pipe(Effect.provide(services)),
);
