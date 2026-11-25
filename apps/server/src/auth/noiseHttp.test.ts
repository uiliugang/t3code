import {
  AuthSessionId,
  NOISE_HTTP_CHUNK_BYTES,
  NOISE_HTTP_MAX_REQUEST_BYTES,
  ORCHESTRATION_PROTOCOL_HEADER,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeZlib from "node:zlib";
import { makeNoiseHttpBridge, noiseHttpSession } from "./noiseHttp.ts";
import { NOISE_SESSION_SUBJECT } from "./SessionStore.ts";
import { allowsNoiseIngress } from "./noiseIngress.ts";

it.effect(
  "routes only finite authenticated requests, preserving upload offsets, session scope and diff bytes",
  () =>
    Effect.gen(function* () {
      const router = yield* HttpRouter.make;
      const session = {
        sessionId: AuthSessionId.make("approved"),
        subject: NOISE_SESSION_SUBJECT,
        scopes: [],
        method: "bearer-access-token" as const,
      };
      const bridge = makeNoiseHttpBridge(session, router);
      const data = new Uint8Array(NOISE_HTTP_CHUNK_BYTES + 7).fill(65);
      yield* router.add(
        "POST",
        "/api/pull-requests/diff",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          expect(noiseHttpSession(request)).toBe(session);
          expect(request.headers[ORCHESTRATION_PROTOCOL_HEADER]).toBe("2");
          expect(request.headers.authorization).toBeUndefined();
          const bytes = yield* Effect.orDie(request.arrayBuffer);
          expect(Buffer.from(bytes).equals(data)).toBe(true);
          return HttpServerResponse.uint8Array(data);
        }),
      );
      const first = { id: 1, offset: 0, data: data.subarray(0, NOISE_HTTP_CHUNK_BYTES) };
      yield* bridge.upload(first);
      expect((yield* Effect.flip(bridge.upload({ ...first, offset: 3 })))._tag).toBe(
        "NoiseHttpError",
      );
      yield* bridge.upload(first);
      yield* bridge.upload({
        id: 1,
        offset: first.data.length,
        data: data.subarray(first.data.length),
      });
      const input = {
        method: "POST" as const,
        path: "/api/pull-requests/diff",
        uploadId: 1,
        protocol: "2",
        deflate: true as const,
      };
      const [meta, block, tail] = yield* bridge.dispatch(input).pipe(Stream.runCollect);
      expect(meta).toMatchObject({ status: 200 });
      if (!block || !("originalSize" in block)) throw new Error("Missing diff block");
      expect(block.originalSize).toBe(NOISE_HTTP_CHUNK_BYTES);
      expect(block.data.byteLength).toBeLessThan(NOISE_HTTP_CHUNK_BYTES);
      expect(NodeZlib.inflateRawSync(block.data).equals(first.data)).toBe(true);
      expect(tail).toEqual({ data: data.subarray(first.data.length) });
      const invalid = (path: string) =>
        bridge.dispatch({ method: "POST", path }).pipe(Stream.runDrain, Effect.flip);
      expect((yield* bridge.dispatch(input).pipe(Stream.runDrain, Effect.flip))._tag).toBe(
        "NoiseHttpError",
      );
      for (const path of [
        "https://noise.invalid/api/pull-requests/diff",
        "//elsewhere/api/voice/status",
        "/api/auth/ws-token",
        "/api/hooks/sealed/encrypted-v1",
      ]) {
        expect((yield* invalid(path))._tag).toBe("NoiseHttpError");
      }
      expect(
        noiseHttpSession(
          HttpServerRequest.fromWeb(
            new Request("https://noise.invalid", {
              headers: { "x-noise-subject": session.subject },
            }),
          ),
        ),
      ).toBeUndefined();
      const chunk = new Uint8Array(NOISE_HTTP_CHUNK_BYTES);
      let offset = 0;
      while (offset + chunk.length <= NOISE_HTTP_MAX_REQUEST_BYTES) {
        yield* bridge.upload({ id: 2, offset, data: chunk });
        offset += chunk.length;
      }
      expect((yield* Effect.flip(bridge.upload({ id: 2, offset, data: chunk })))._tag).toBe(
        "NoiseHttpError",
      );
    }).pipe(Effect.scoped),
);

it("restricts strict host ingress to the pinned transport, control plane and encrypted deliveries", () => {
  expect(allowsNoiseIngress("GET", "/api/connect/e2ee/v1")).toBe(true);
  expect(allowsNoiseIngress("POST", "/api/hooks/" + "a".repeat(43) + "/encrypted-v1")).toBe(true);
  for (const path of [
    "/ws",
    "/guest",
    "/mcp",
    "/api/assets/signed",
    "/api/hooks/private/token",
    "/api/auth/pairing-token",
  ]) {
    expect(allowsNoiseIngress("GET", path)).toBe(false);
    expect(allowsNoiseIngress("POST", path)).toBe(false);
  }
});
