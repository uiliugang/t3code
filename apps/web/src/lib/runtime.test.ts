import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
// Load the runtime's module graph once at collection, outside the per-test timeout;
// each case re-evaluates it from that cache after vi.resetModules().
import "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("web runtime tracing", () => {
  it("keeps user tracing without exporting to configured legacy relay collectors", async () => {
    vi.resetModules();
    vi.stubEnv("T3CODE_TELEMETRY_ENABLED", "true");
    vi.stubEnv("T3CODE_OTEL_SDK_DISABLED", "false");
    vi.stubEnv("OTEL_SDK_DISABLED", "false");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubGlobal("window", {});
    const listUrl = "https://relay.example.test/v1/environments";
    const fetchFn = vi.fn<typeof fetch>(async (input) =>
      String(input) === listUrl
        ? Response.json({ environments: [] })
        : new Response(null, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchFn);
    const { runtime: freshRuntime } = await import("./runtime");
    const { ManagedRelay } = await import("@t3tools/client-runtime/relay");
    const { setDelegate } = await import("../observability/clientTracer");
    const userSpans: Array<string> = [];

    try {
      expect(
        await freshRuntime.runPromise(
          ManagedRelay.ManagedRelayClient.pipe(
            Effect.flatMap((client) => client.listEnvironments({ clerkToken: "test-token" })),
          ),
        ),
      ).toEqual([]);

      setDelegate(
        Tracer.make({
          span(options) {
            userSpans.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        }),
      );
      await freshRuntime.runPromise(Effect.void.pipe(Effect.withSpan("user.work")));
      expect(userSpans).toEqual(["user.work"]);
    } finally {
      setDelegate(null);
      await freshRuntime.dispose();
    }

    expect(fetchFn.mock.calls.map(([input]) => String(input))).toEqual([listUrl]);
  });
});
