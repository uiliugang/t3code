import {
  ProviderSetupError,
  type CodexSettings,
  type ProviderEndpointValidateInput,
} from "@t3tools/contracts";
import { codexByokUrlError } from "@t3tools/shared/codexByok";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const decodeCatalog = Schema.decodeUnknownEffect(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);
const decodeResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.String,
    output: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        name: Schema.optional(Schema.String),
        arguments: Schema.optional(Schema.String),
        call_id: Schema.optional(Schema.String),
      }),
    ),
  }),
);

const decodeOutput = Schema.decodeUnknownEffect(
  Schema.Struct({ output: Schema.Array(Schema.Unknown) }),
);
const decodeToolInput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.Literal("t3-byok") })),
);
const isSetupError = Schema.is(ProviderSetupError);

export const validateCodexEndpoint = Effect.fn("CodexEndpointValidation.validate")(function* (
  input: ProviderEndpointValidateInput,
  config: CodexSettings,
  environment: NodeJS.ProcessEnv,
) {
  const fail = (detail: string) =>
    new ProviderSetupError({
      instanceId: input.instanceId,
      operation: "validate-endpoint",
      detail,
    });
  const base = environment.T3_CODEX_BASE_URL ?? "";
  const error = codexByokUrlError(base);
  if (error) return yield* fail(error);
  const key = environment.T3_CODEX_API_KEY;
  if (!key?.trim()) return yield* fail("Enter an API key.");
  const client = yield* HttpClient.HttpClient;
  const endpoint = base.trim().replace(/\/+$/, "");
  const request = Effect.fn("CodexEndpointValidation.request")(function* (
    path: string,
    body?: unknown,
  ) {
    const req =
      body === undefined
        ? HttpClientRequest.get(endpoint + path)
        : HttpClientRequest.post(endpoint + path).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    const response = yield* client.execute(req.pipe(HttpClientRequest.bearerToken(key)));
    if (response.status < 200 || response.status >= 300)
      return yield* fail(
        response.status === 401
          ? "API returned HTTP 401. Check the API key."
          : response.status === 403
            ? "API returned HTTP 403. Check the key and model permissions."
            : response.status === 404
              ? "API returned HTTP 404. Check the API path; this service may not support model listing."
              : response.status === 429
                ? "API returned HTTP 429. Check the quota and try again later."
                : "API request failed. Check service availability and try again.",
      );
    return yield* response.json;
  });
  const program = Effect.gen(function* () {
    if (input.check === "connection") {
      yield* request("/models").pipe(Effect.flatMap(decodeCatalog));
      return {
        authenticated: true,
        message: "Model listing accepted the API key. Inference is unverified.",
      };
    }
    const model = input.model;
    if (
      !model ||
      !readCustomModelEntries(config.customModels).some((entry) => entry.slug === model)
    )
      return yield* fail("Select a configured model.");
    const raw = yield* request("/responses", {
      model,
      input: "Call t3_check with value t3-byok.",
      tools: [
        {
          type: "function",
          name: "t3_check",
          description: "Connection test",
          parameters: {
            type: "object",
            properties: { value: { type: "string", const: "t3-byok" } },
            required: ["value"],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "t3_check" },
      store: false,
    });
    const response = yield* decodeResponse(raw);
    const rawOutput = yield* decodeOutput(raw);
    const call = response.output.find(
      (item) => item.type === "function_call" && item.name === "t3_check",
    );
    if (!call?.call_id || !call.arguments)
      return yield* fail("The model did not return the requested tool call.");
    yield* decodeToolInput(call.arguments);
    const followup = yield* request("/responses", {
      model,
      input: [
        ...rawOutput.output,
        { type: "function_call_output", call_id: call.call_id, output: "ok" },
      ],
      store: false,
    }).pipe(Effect.flatMap(decodeResponse));
    if (!followup.output.some((item) => item.type === "message"))
      return yield* fail("The model did not complete the tool response.");
    return { authenticated: true, message: "The model completed a Responses API tool round trip." };
  });
  return yield* program.pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) =>
      isSetupError(cause)
        ? cause
        : fail("API check failed. Check connectivity and Responses API compatibility."),
    ),
  );
});
