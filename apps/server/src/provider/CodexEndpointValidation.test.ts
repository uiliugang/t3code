import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { validateCodexEndpoint } from "./CodexEndpointValidation.ts";

const config = Schema.decodeSync(CodexSettings)({
  connectionMode: "byok",
  customModels: ["CaseSensitive"],
});
const instanceId = ProviderInstanceId.make("byok");
it.effect(
  "checks only the selected endpoint and credential without inference and redacts failures",
  () =>
    Effect.gen(function* () {
      for (const status of [200, 401, 403, 404, 500]) {
        const result = yield* validateCodexEndpoint({ instanceId, check: "connection" }, config, {
          T3_CODEX_BASE_URL: "https://api.test/team/v1/",
          T3_CODEX_API_KEY: "instance-secret",
          OPENAI_API_KEY: "unrelated-secret",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              assert.strictEqual(request.url, "https://api.test/team/v1/models");
              assert.strictEqual(request.method, "GET");
              assert.strictEqual(request.headers.authorization, "Bearer instance-secret");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ data: [{ id: "CaseSensitive" }] }, { status }),
                ),
              );
            }),
          ),
          Effect.result,
        );
        assert.strictEqual(result._tag, status === 200 ? "Success" : "Failure");
        if (result._tag === "Failure") assert.notInclude(result.failure.detail, "secret");
      }
    }),
);

it.effect("never sends an unconfigured model to the endpoint", () =>
  Effect.gen(function* () {
    const result = yield* validateCodexEndpoint(
      { instanceId, check: "model", model: "wrong-case" },
      config,
      {
        T3_CODEX_BASE_URL: "https://api.test/v1",
        T3_CODEX_API_KEY: "key",
      },
    ).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected paid request")),
      ),
      Effect.result,
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("keeps the exact model and complete tool output through the Responses round trip", () =>
  Effect.gen(function* () {
    const output = [
      { type: "reasoning", id: "reasoning", encrypted_content: "opaque", summary: [] },
      {
        type: "function_call",
        id: "call",
        call_id: "call-1",
        name: "t3_check",
        arguments: '{"value":"t3-byok"}',
      },
    ];
    const requests: Array<Record<string, unknown>> = [];
    const result = yield* validateCodexEndpoint(
      { instanceId, check: "model", model: "CaseSensitive" },
      config,
      {
        T3_CODEX_BASE_URL: "https://api.test/team/v1",
        T3_CODEX_API_KEY: "key",
      },
    ).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          assert.strictEqual(request.url, "https://api.test/team/v1/responses");
          assert.strictEqual(request.method, "POST");
          assert.strictEqual(request.body._tag, "Uint8Array");
          if (request.body._tag !== "Uint8Array") return Effect.die("Missing JSON body");
          const body = JSON.parse(new TextDecoder().decode(request.body.body)) as Record<
            string,
            unknown
          >;
          requests.push(body);
          assert.strictEqual(body.model, "CaseSensitive");
          assert.strictEqual(body.store, false);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                id: "response",
                output:
                  requests.length === 1
                    ? output
                    : [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
              }),
            ),
          );
        }),
      ),
    );
    assert.isTrue(result.authenticated);
    assert.strictEqual(requests.length, 2);
    assert.deepEqual(requests[1]?.input, [
      ...output,
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ]);
  }),
);
