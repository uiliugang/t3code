import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  DesktopSshEnvironmentRequestError,
  disconnectSshEnvironment,
  ensureSshEnvironment,
  fetchSshEnvironmentDescriptor,
} from "./sshEnvironment.ts";
import { DesktopSshEnvironment } from "../../ssh/DesktopSshEnvironment.ts";

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

describe("SSH environment IPC", () => {
  it.effect("switching off interrupts the pending install and clears its progress", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const target = { alias: "box", hostname: "box", username: null, port: null };
      const updates: unknown[] = [];
      const event = {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: (_channel: string, ...args: unknown[]) => {
            updates.push(args);
          },
        },
      };
      yield* Effect.gen(function* () {
        const install = yield* Effect.forkChild(ensureSshEnvironment.handler({ target }, event));
        yield* Deferred.await(started);
        yield* disconnectSshEnvironment.handler(target, event);
        assert.deepEqual(yield* Fiber.join(install), {
          type: "ssh-password-prompt-cancelled",
          message: "SSH installation cancelled.",
        });
        assert.deepEqual(updates, [
          [target, { phase: "downloading", bytes: 128 }],
          [target, { phase: "finished" }],
        ]);
      }).pipe(
        Effect.provide(
          Layer.mock(DesktopSshEnvironment, {
            ensureEnvironment: (_target, options) =>
              Effect.sync(() => {
                options?.reportInstallProgress?.({ phase: "downloading", bytes: 128 });
              }).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              ),
            disconnectEnvironment: () => Deferred.await(interrupted),
          }),
        ),
      );
    }),
  );

  it.effect("rejects non-loopback HTTP endpoints before issuing a request", () => {
    let requestCount = 0;
    const layer = layerHttpClient((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return jsonResponse(request, {});
      }),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://remote.example.com:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.instanceOf(error.cause, SshHttpBridgeError);
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(layer));
  });
});
