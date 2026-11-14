import {
  ProviderSetupError,
  type ClaudeSettings,
  type ProviderEndpointValidateInput,
  type ProviderEndpointValidation,
} from "@t3tools/contracts";
import {
  claudeByokModelError,
  claudeByokUrlError,
  normalizeClaudeByokBaseUrl,
} from "@t3tools/shared/claudeByok";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ToolBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
const ThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.optional(Schema.String),
});
const Block = Schema.Union([TextBlock, ToolBlock, ThinkingBlock]);
const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message_start") }),
  Schema.Struct({ type: Schema.Literal("ping") }),
  Schema.Struct({
    type: Schema.Literal("content_block_start"),
    index: Schema.Int,
    content_block: Block,
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Int,
    delta: Schema.Union([
      Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
      Schema.Struct({ type: Schema.Literal("thinking_delta"), thinking: Schema.String }),
      Schema.Struct({ type: Schema.Literal("signature_delta"), signature: Schema.String }),
      Schema.Struct({ type: Schema.Literal("input_json_delta"), partial_json: Schema.String }),
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("content_block_stop"), index: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("message_delta"),
    delta: Schema.Struct({ stop_reason: Schema.NullOr(Schema.String) }),
  }),
  Schema.Struct({ type: Schema.Literal("message_stop") }),
]);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(Event));
const ToolInput = Schema.Struct({ value: Schema.Literal("t3-byok") });
const decodeToolInput = Schema.decodeUnknownEffect(ToolInput);
const isSetupError = Schema.is(ProviderSetupError);
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolInput));
const decodeModels = Schema.decodeUnknownEffect(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);

export const validateClaudeEndpoint = Effect.fn("ClaudeEndpointValidation.validate")(function* (
  config: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  input: ProviderEndpointValidateInput,
  checkRuntime: Effect.Effect<void, ProviderSetupError>,
): Effect.fn.Return<ProviderEndpointValidation, ProviderSetupError, HttpClient.HttpClient> {
  const fail = (detail: string) =>
    new ProviderSetupError({ instanceId: input.instanceId, operation: "validate", detail });
  const base = environment.ANTHROPIC_BASE_URL?.trim() ?? "";
  const urlError = claudeByokUrlError(base);
  if (urlError) return yield* fail(urlError);
  const token = environment.ANTHROPIC_AUTH_TOKEN?.trim();
  const key = environment.ANTHROPIC_API_KEY?.trim();
  if (Boolean(token) === Boolean(key))
    return yield* fail("Configure exactly one Bearer Token or API Key.");
  const client = HttpClient.mapRequest(
    yield* HttpClient.HttpClient,
    HttpClientRequest.setHeaders({
      "anthropic-version": "2023-06-01",
      ...(token ? { authorization: `Bearer ${token}` } : { "x-api-key": key! }),
    }),
  );
  const endpoint = (path: string) => `${normalizeClaudeByokBaseUrl(base)}/v1/${path}`;
  const checkStatus = (response: HttpClientResponse.HttpClientResponse) => {
    const status = response.status;
    if (status >= 200 && status < 300) return Effect.succeed(response);
    return Effect.fail(
      fail(
        status === 401
          ? "BA rejected the credential (401)."
          : status === 403
            ? "BA denied access (403). Check endpoint permissions."
            : status === 404
              ? "The requested endpoint or model was not found (404)."
              : status === 429
                ? "BA rate limit reached (429). Try again later."
                : status >= 500
                  ? "BA is unavailable (server error)."
                  : `BA rejected the request (${status}). Check the exact model ID, request parameters, and selected API protocol.`,
      ),
    );
  };
  const program = Effect.gen(function* () {
    if (input.check === "connection") {
      yield* checkRuntime.pipe(
        Effect.mapError(() =>
          fail("Claude Code could not initialize. Check the executable and isolated home."),
        ),
      );
      const response = yield* client.get(endpoint("models"));
      if ([403, 404, 405].includes(response.status))
        return {
          authenticated: false,
          message:
            "Claude Code started; BA responded. Model listing is unavailable, so authentication and inference are unverified.",
        };
      yield* checkStatus(response);
      yield* response.json.pipe(Effect.flatMap(decodeModels));
      return {
        authenticated: true,
        message:
          "Claude Code started and BA model listing accepted the credential. Inference is unverified.",
      };
    }
    const model = input.model ?? "";
    const modelError = claudeByokModelError(config, model);
    if (modelError || !model) return yield* fail(modelError ?? "Select a configured model.");
    const readMessage = Effect.fn("ClaudeEndpointValidation.readMessage")(function* (
      body: unknown,
    ) {
      const request = HttpClientRequest.post(endpoint("messages")).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      );
      const response = yield* client.execute(request).pipe(Effect.flatMap(checkStatus));
      if (!response.headers["content-type"]?.includes("text/event-stream"))
        return yield* fail("BA did not return an Anthropic SSE stream.");
      const frames = yield* response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.take(257),
        Stream.runCollect,
      );
      if (frames.length > 256) return yield* fail("BA returned too many events for this check.");
      const blocks = new Map<number, { block: typeof Block.Type; json: string; closed: boolean }>();
      let started = false;
      let stopped = false;
      let stopReason: string | null = null;
      for (const frame of frames) {
        const event = yield* decodeEvent(frame.data);
        if (event.type === "ping") continue;
        if (stopped) return yield* fail("BA sent events after message_stop.");
        if (event.type === "message_start") {
          if (started) return yield* fail("BA sent duplicate message_start events.");
          started = true;
          continue;
        }
        if (!started) return yield* fail("BA stream is missing message_start.");
        switch (event.type) {
          case "content_block_start":
            if (blocks.has(event.index)) return yield* fail("BA reused a content block index.");
            blocks.set(event.index, { block: event.content_block, json: "", closed: false });
            break;
          case "content_block_delta": {
            const entry = blocks.get(event.index);
            if (!entry || entry.closed)
              return yield* fail("BA sent a delta outside an open content block.");
            if (entry.block.type === "text" && event.delta.type === "text_delta")
              entry.block = { ...entry.block, text: entry.block.text + event.delta.text };
            else if (entry.block.type === "tool_use" && event.delta.type === "input_json_delta")
              entry.json += event.delta.partial_json;
            else if (entry.block.type === "thinking" && event.delta.type === "thinking_delta")
              entry.block = {
                ...entry.block,
                thinking: entry.block.thinking + event.delta.thinking,
              };
            else if (entry.block.type === "thinking" && event.delta.type === "signature_delta")
              entry.block = {
                ...entry.block,
                signature: (entry.block.signature ?? "") + event.delta.signature,
              };
            else return yield* fail("BA sent an incompatible content delta.");
            break;
          }
          case "content_block_stop": {
            const entry = blocks.get(event.index);
            if (!entry || entry.closed)
              return yield* fail("BA sent an invalid content_block_stop.");
            entry.closed = true;
            break;
          }
          case "message_delta":
            stopReason = event.delta.stop_reason;
            break;
          case "message_stop":
            stopped = true;
            break;
        }
      }
      if (!stopped || !stopReason || [...blocks.values()].some((entry) => !entry.closed))
        return yield* fail("BA stream ended before the message completed.");
      return { blocks: [...blocks.values()], stopReason };
    });
    const tools = [
      {
        name: "t3_echo",
        description: "Echo a fixed diagnostic value.",
        input_schema: {
          type: "object",
          properties: { value: { type: "string", enum: ["t3-byok"] } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ];
    const messages: unknown[] = [
      { role: "user", content: "Call t3_echo with value t3-byok, then repeat the tool result." },
    ];
    const first = yield* readMessage({
      model,
      max_tokens: 256,
      stream: true,
      tools,
      // OpenAI thinking models can reject forced tool choices.
      tool_choice:
        environment.T3_CLAUDE_API_FORMAT === "openai"
          ? { type: "auto" }
          : { type: "tool", name: "t3_echo" },
      messages,
    });
    const calls = first.blocks.filter((entry) => entry.block.type === "tool_use");
    const call = calls[0];
    if (
      first.stopReason !== "tool_use" ||
      calls.length !== 1 ||
      !call ||
      call.block.type !== "tool_use" ||
      call.block.name !== "t3_echo" ||
      !call.block.id
    )
      return yield* fail("BA did not return the requested echo tool call.");
    const args = yield* call.json ? decodeInput(call.json) : decodeToolInput(call.block.input);
    messages.push({
      role: "assistant",
      content: first.blocks.map((entry) =>
        entry === call ? { ...call.block, input: args } : entry.block,
      ),
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: call.block.id, content: args.value }],
    });
    const final = yield* readMessage({
      model,
      max_tokens: 256,
      stream: true,
      tools,
      tool_choice: { type: "none" },
      messages,
    });
    if (
      final.stopReason !== "end_turn" ||
      final.blocks.some((entry) => entry.block.type === "tool_use") ||
      !final.blocks.some(
        (entry) => entry.block.type === "text" && entry.block.text.includes(args.value),
      )
    )
      return yield* fail("BA did not complete the echo tool round trip.");
    return {
      authenticated: true,
      message: "Model, streamed response, and echo tool round trip passed.",
    };
  });
  return yield* program.pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(fail("The BA check timed out. Try again or cancel the request.")),
    }),
    Effect.mapError((cause) =>
      isSetupError(cause)
        ? cause
        : fail(
            "BA check failed: network, malformed response, or incomplete stream. Check the selected API protocol.",
          ),
    ),
    Effect.scoped,
  );
});
