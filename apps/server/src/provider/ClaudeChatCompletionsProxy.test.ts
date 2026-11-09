// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Native HTTP protocol adapter shared with the standalone Node CLI.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import { expect, it } from "vite-plus/test";
import { startClaudeChatCompletionsProxy } from "./ClaudeChatCompletionsProxy.ts";

it("translates streamed tools and results, rejects incomplete streams and hides upstream errors", async () => {
  const requests: unknown[] = [];
  let mode: "tools" | "text" | "broken" | "error" | "hang" | "refusal" = "tools";
  const disconnected = Promise.withResolvers<void>();
  const upstream = NodeHttp.createServer(async (request, response) => {
    expect(request.headers.authorization).toBe("Bearer upstream-key");
    if (request.url === "/custom/v4/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "Exact-model" }] }));
      return;
    }
    expect(request.url).toBe("/custom/v4/chat/completions");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (mode === "error") {
      response.writeHead(429);
      response.end("upstream-key is secret");
      return;
    }
    if (!body.stream) {
      response.end(
        JSON.stringify({
          id: "msg",
          choices: [{ finish_reason: "stop", message: { content: "你好" } }],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        }),
      );
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    if (mode === "hang") {
      response.on("close", () => disconnected.resolve());
      response.write("data: ");
      return;
    }
    const send = (delta: unknown, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`,
      );
    if (mode === "tools") {
      send({
        tool_calls: [
          { index: 0, id: "call-one", function: { name: "ec", arguments: '{"value":' } },
          { index: 1, id: "call-two", function: { name: "echo", arguments: '{"value":"two"}' } },
        ],
      });
      send({ tool_calls: [{ index: 0, function: { name: "ho", arguments: '"一"}' } }] });
      send({}, "tool_calls");
    } else if (mode === "refusal") {
      send({ refusal: "Cannot help " });
      send({ refusal: "with this request." });
      send({}, "stop");
    } else {
      send({ content: "你好" });
      if (mode !== "broken") send({}, "stop");
    }
    response.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\r\n\r\n`,
    );
    response.end("data: [DONE]\r\n\r\n");
  });
  upstream.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(upstream, "listening");
  await using _upstream = upstream;
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const proxy = await startClaudeChatCompletionsProxy({
    baseUrl: `http://127.0.0.1:${address.port}/custom/v4/`,
    apiKey: "upstream-key",
  });
  try {
    const call = (stream: boolean, messages: unknown[] = [{ role: "user", content: "hello" }]) =>
      fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "Exact-model", max_tokens: 100, stream, messages }),
      });
    expect((await fetch(`${proxy.baseUrl}/v1/models`)).status).toBe(401);
    const models = await fetch(`${proxy.baseUrl}/v1/models`, {
      headers: { "x-api-key": proxy.token },
    });
    expect(await models.json()).toMatchObject({ data: [{ id: "Exact-model" }] });
    const first = await call(true);
    const frames = (await first.text())
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
    expect(frames.at(-1)).toEqual({ type: "message_stop" });
    expect(
      frames
        .filter((frame) => frame.type === "content_block_start")
        .map((frame) => frame.content_block),
    ).toEqual([
      { type: "tool_use", id: "call-one", name: "echo", input: {} },
      { type: "tool_use", id: "call-two", name: "echo", input: {} },
    ]);
    expect(frames.find((frame) => frame.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    mode = "text";
    const final = await call(true, [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-one", name: "echo", input: { value: "一" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-one", content: "一" }] },
    ]);
    expect(await final.text()).toContain('"text":"你好"');
    expect(requests.at(-1)).toMatchObject({
      model: "Exact-model",
      messages: [
        { role: "assistant", tool_calls: [{ id: "call-one" }] },
        { role: "tool", tool_call_id: "call-one", content: "一" },
      ],
    });
    expect(await (await call(false)).json()).toMatchObject({
      content: [{ type: "text", text: "你好" }],
      stop_reason: "end_turn",
    });
    mode = "refusal";
    const refusal = await call(true);
    const refusalFrames = (await refusal.text())
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
    expect(
      refusalFrames
        .filter((frame) => frame.type === "content_block_delta")
        .map((frame) => frame.delta.text)
        .join(""),
    ).toBe("Cannot help with this request.");
    expect(refusalFrames.find((frame) => frame.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "end_turn" },
    });
    expect(refusalFrames.at(-1)).toEqual({ type: "message_stop" });
    mode = "broken";
    const broken = await (await call(true)).text();
    expect(broken).toContain("event: error");
    expect(broken).not.toContain("event: message_stop");
    mode = "hang";
    const controller = new AbortController();
    const pending = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        model: "Exact-model",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "cancel" }],
      }),
    });
    const pendingResponse = await pending;
    controller.abort();
    await expect(pendingResponse.text()).rejects.toThrow();
    await disconnected.promise;
    mode = "error";
    const rejected = await call(false);
    expect(rejected.status).toBe(429);
    expect(await rejected.text()).not.toContain("upstream-key");
  } finally {
    await proxy.close();
  }
});
