import { assert, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { validateClaudeEndpoint } from "./ClaudeEndpointValidation.ts";

const config = Schema.decodeSync(ClaudeSettings)({
  customModelsOnly: true,
  customModels: ["CaseSensitive"],
});
const instanceId = ProviderInstanceId.make("byok");
const environment = {
  ANTHROPIC_BASE_URL: "https://ba.test/prefix/v1/",
  ANTHROPIC_AUTH_TOKEN: "secret",
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const stream = (tool: boolean, complete = true) =>
  [
    { type: "message_start" },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "echo_123", name: "t3_echo", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? { type: "input_json_delta", partial_json: '{"value":"t3-byok"}' }
        : { type: "text_delta", text: "t3-byok" },
    },
    { type: "content_block_stop", index: 0 },
    ...(complete
      ? [
          { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" } },
          { type: "message_stop" },
        ]
      : []),
  ]
    .map((event) => `event: ${event.type}\ndata: ${encode(event)}\n\n`)
    .join("");

it.effect("checks optional model listing without sending a billable inference request", () =>
  Effect.gen(function* () {
    for (const status of [200, 403, 404, 405, 400, 401, 422, 429, 500]) {
      let initialized = false;
      const result = yield* validateClaudeEndpoint(
        config,
        environment,
        { instanceId, check: "connection" },
        Effect.sync(() => {
          initialized = true;
        }),
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            assert.strictEqual(request.url, "https://ba.test/prefix/v1/models");
            assert.strictEqual(request.method, "GET");
            assert.strictEqual(request.headers.authorization, "Bearer secret");
            assert.isUndefined(request.headers["x-api-key"]);
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ data: [] }, { status })),
            );
          }),
        ),
        Effect.result,
      );
      assert.isTrue(initialized);
      if ([200, 403, 404, 405].includes(status)) {
        assert.strictEqual(result._tag, "Success");
        if (result._tag === "Success")
          assert.strictEqual(result.success.authenticated, status === 200);
      } else {
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.notInclude(result.failure.message, "secret");
          if (status === 400 || status === 422) {
            assert.include(result.failure.message, String(status));
            assert.include(result.failure.message, "model");
            assert.notInclude(result.failure.message, "Anthropic protocol");
          }
        }
      }
    }
  }),
);

it.effect.each(["anthropic", "openai"] as const)(
  "tests the %s tool round trip with exact model IDs and the selected auth header",
  (protocol) =>
    Effect.gen(function* () {
      let requests = 0;
      const result = yield* validateClaudeEndpoint(
        config,
        {
          ...environment,
          T3_CLAUDE_API_FORMAT: protocol,
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_API_KEY: "api-key",
        },
        { instanceId, check: "model", model: "CaseSensitive" },
        Effect.void,
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              assert.strictEqual(request.url, "https://ba.test/prefix/v1/messages");
              assert.strictEqual(request.headers["x-api-key"], "api-key");
              assert.isUndefined(request.headers.authorization);
              assert.strictEqual(request.headers["anthropic-version"], "2023-06-01");
              assert.strictEqual(request.body._tag, "Uint8Array");
              if (request.body._tag === "Uint8Array") {
                const body = new TextDecoder().decode(request.body.body);
                assert.include(body, '"model":"CaseSensitive"');
                if (requests === 0)
                  assert.include(
                    body,
                    protocol === "openai"
                      ? '"tool_choice":{"type":"auto"}'
                      : '"tool_choice":{"type":"tool","name":"t3_echo"}',
                  );
                else {
                  assert.include(body, '"tool_use_id":"echo_123"');
                  assert.include(body, '"tool_choice":{"type":"none"}');
                }
              }
              return HttpClientResponse.fromWeb(
                request,
                new Response(stream(requests++ === 0), {
                  headers: { "content-type": "text/event-stream" },
                }),
              );
            }),
          ),
        ),
      );
      assert.strictEqual(requests, 2);
      assert.isTrue(result.authenticated);
    }),
);

it.effect(
  "rejects conflicting auth, unknown models and incomplete or invalid streams without retrying",
  () =>
    Effect.gen(function* () {
      let requests = 0;
      const http = HttpClient.make((request) => {
        requests++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(stream(true, false), { headers: { "content-type": "text/event-stream" } }),
          ),
        );
      });
      for (const [env, model] of [
        [{ ...environment, ANTHROPIC_API_KEY: "other" }, "CaseSensitive"],
        [environment, "sonnet"],
        [environment, "CaseSensitive"],
      ] as const) {
        const error = yield* validateClaudeEndpoint(
          config,
          env,
          { instanceId, check: "model", model },
          Effect.void,
        ).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip);
        assert.notInclude(error.message, "secret");
      }
      assert.strictEqual(requests, 1);
    }),
);
