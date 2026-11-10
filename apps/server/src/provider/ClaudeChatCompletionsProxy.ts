// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Native HTTP protocol adapter shared with the standalone Node CLI.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import type * as Zod from "zod";
import { claudeByokUrlError } from "@t3tools/shared/claudeByok";
import {
  ChatChunk,
  ClaudeMessageRequest,
  fromChatCompletion,
  stopReason,
  toChatCompletions,
  usage,
} from "./ClaudeChatCompletions.ts";

const { z } = NodeModule.createRequire(import.meta.url)("zod") as typeof Zod;
const MAX_BYTES = 16 * 1024 * 1024;
const Models = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) });

// This Node HTTP adapter is shared by the scoped provider and the standalone CLI.
export async function startClaudeChatCompletionsProxy(options: {
  baseUrl: string;
  apiKey: string;
  token?: string;
  port?: number;
}) {
  const error = claudeByokUrlError(options.baseUrl);
  if (error || !options.apiKey.trim()) throw new Error(error ?? "Configure an upstream API key.");
  const url = new URL(options.baseUrl.trim());
  const endpoint = url.pathname.replace(/\/+$/, "")
    ? url.toString().replace(/\/+$/, "")
    : `${url.origin}/v1`;
  const token = options.token ?? NodeCrypto.randomUUID();
  const controllers = new Set<AbortController>();
  const server = NodeHttp.createServer(async (request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    response.on("close", () => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const fail = (status: number, message: string) =>
      json(status, {
        type: "error",
        error: { type: status === 400 ? "invalid_request_error" : "api_error", message },
      });
    try {
      if (
        request.headers.authorization !== `Bearer ${token}` &&
        request.headers["x-api-key"] !== token
      ) {
        fail(401, "Invalid local proxy credential.");
        return;
      }
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const headers = {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      };
      if (request.method === "GET" && path === "/v1/models") {
        const upstream = await fetch(`${endpoint}/models`, { headers, signal, redirect: "error" });
        if (!upstream.ok) {
          fail(upstream.status, `Upstream model listing failed (${upstream.status}).`);
          await upstream.body?.cancel();
          return;
        }
        const models = Models.parse(await upstream.json());
        json(200, {
          data: models.data.map((model) => ({ ...model, type: "model", display_name: model.id })),
          has_more: false,
        });
        return;
      }
      if (request.method !== "POST" || path !== "/v1/messages") {
        fail(404, "Unsupported proxy endpoint.");
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BYTES) {
          fail(413, "Request exceeds the local proxy limit.");
          return;
        }
        chunks.push(buffer);
      }
      const parsed = ClaudeMessageRequest.safeParse(
        (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return undefined;
          }
        })(),
      );
      if (!parsed.success) {
        fail(400, "Unsupported or malformed Claude Messages request.");
        return;
      }
      const body = parsed.data;
      const upstream = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(toChatCompletions(body)),
        signal,
        redirect: "error",
      });
      if (!upstream.ok) {
        fail(upstream.status, `Upstream Chat Completions request failed (${upstream.status}).`);
        await upstream.body?.cancel();
        return;
      }
      if (!body.stream) {
        json(200, fromChatCompletion(await upstream.json(), body.model));
        return;
      }
      if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
        await upstream.body?.cancel();
        fail(502, "Upstream did not return an SSE stream.");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      await translateStream(upstream.body, body.model, response, signal);
      response.end();
    } catch (cause) {
      if (response.destroyed) return;
      const message =
        cause instanceof z.ZodError || cause instanceof SyntaxError
          ? "Unsupported or malformed protocol payload."
          : "The upstream request failed or its stream was incomplete.";
      if (response.headersSent) {
        response.end(
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`,
        );
      } else fail(502, message);
    } finally {
      controller.abort();
      controllers.delete(controller);
    }
  });
  server.requestTimeout = 30_000;
  server.listen(options.port ?? 0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind a TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    close: async () => {
      for (const controller of controllers) controller.abort();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

async function translateStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  response: NodeHttp.ServerResponse,
  signal: AbortSignal,
) {
  const send = async (event: { type: string; [key: string]: unknown }) => {
    if (signal.aborted) throw new Error("Cancelled");
    if (!response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      await NodeEvents.EventEmitter.once(response, "drain", { signal });
  };
  await send({
    type: "message_start",
    message: {
      id: `msg_${NodeCrypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  let nextIndex = 0;
  let active: { kind: "text" | "thinking"; index: number } | undefined;
  let finish: string | null = null;
  let tokenUsage = usage(undefined);
  let bytes = 0;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const closeBlock = async () => {
    if (active) await send({ type: "content_block_stop", index: active.index });
    active = undefined;
  };
  const append = async (kind: "text" | "thinking", text: string) => {
    if (!text) return;
    if (active?.kind !== kind) {
      await closeBlock();
      active = { kind, index: nextIndex++ };
      await send({
        type: "content_block_start",
        index: active.index,
        content_block:
          kind === "text"
            ? { type: "text", text: "" }
            : { type: "thinking", thinking: "", signature: "" },
      });
    }
    await send({
      type: "content_block_delta",
      index: active.index,
      delta:
        kind === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
    });
  };
  const input = NodeStream.Readable.from(body);
  const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  let data: string[] = [];
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_BYTES) throw new Error("Upstream response exceeds limit");
      if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
        continue;
      }
      if (line !== "" || !data.length) continue;
      const value = data.join("\n");
      data = [];
      if (value === "[DONE]") break;
      const chunk = ChatChunk.parse(JSON.parse(value));
      if (chunk.usage) tokenUsage = usage(chunk.usage);
      for (const choice of chunk.choices) {
        if (choice.index !== 0) continue;
        if (
          finish &&
          (choice.delta.content ||
            choice.delta.refusal ||
            choice.delta.reasoning_content ||
            choice.delta.tool_calls?.length)
        )
          throw new Error("Content after finish");
        await append("thinking", choice.delta.reasoning_content ?? "");
        await append("text", choice.delta.content ?? "");
        if (choice.delta.refusal) {
          await append("text", choice.delta.refusal);
        }
        for (const call of choice.delta.tool_calls ?? []) {
          const current = calls.get(call.index) ?? { id: "", name: "", arguments: "" };
          if (call.id) current.id = call.id;
          current.name += call.function?.name ?? "";
          current.arguments += call.function?.arguments ?? "";
          calls.set(call.index, current);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
    if (!finish) throw new Error("Stream missing finish_reason");
    await closeBlock();
    for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) throw new Error("Incomplete tool call");
      z.record(z.string(), z.unknown()).parse(JSON.parse(call.arguments));
      const index = nextIndex++;
      await send({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      });
      await send({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: call.arguments },
      });
      await send({ type: "content_block_stop", index });
    }
    if (calls.size && finish !== "tool_calls") throw new Error("Inconsistent tool finish reason");
    await send({
      type: "message_delta",
      delta: { stop_reason: stopReason(finish), stop_sequence: null },
      usage: tokenUsage,
    });
    await send({ type: "message_stop" });
  } finally {
    lines.close();
    await input[Symbol.asyncDispose]();
  }
}
