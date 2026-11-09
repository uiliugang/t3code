import { expect, it } from "vite-plus/test";
import { fromChatCompletion, toChatCompletions } from "./ClaudeChatCompletions.ts";

it("preserves mixed tool results, exact model IDs, images and tool choices", () => {
  const result = toChatCompletions({
    model: "Exact-model",
    max_tokens: 123,
    stream: true,
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "echo", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "echo" },
    messages: [
      { role: "system", content: "Claude runtime context" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "one", name: "echo", input: { x: 1 } },
          { type: "tool_use", id: "two", name: "echo", input: {} },
          { type: "tool_use", id: "three", name: "echo", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "one",
            content: [
              { type: "text", text: "result" },
              { type: "image", source: { type: "url", url: "https://images.example/result.png" } },
            ],
          },
          { type: "tool_result", tool_use_id: "two", content: [] },
          { type: "tool_result", tool_use_id: "three" },
          { type: "text", text: "continue" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  });
  expect(result.model).toBe("Exact-model");
  expect(result.messages).toEqual([
    { role: "system", content: "system" },
    { role: "system", content: "Claude runtime context" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "one", type: "function", function: { name: "echo", arguments: '{"x":1}' } },
        { id: "two", type: "function", function: { name: "echo", arguments: "{}" } },
        { id: "three", type: "function", function: { name: "echo", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "one", content: "result" },
    { role: "tool", tool_call_id: "two", content: "" },
    { role: "tool", tool_call_id: "three", content: "" },
    {
      role: "user",
      content: [
        { type: "text", text: "Image from tool result one:" },
        { type: "image_url", image_url: { url: "https://images.example/result.png" } },
        { type: "text", text: "continue" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ]);
  expect(result.tool_choice).toEqual({ type: "function", function: { name: "echo" } });
  expect(() =>
    toChatCompletions({
      model: "x",
      max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "document" }] }],
    }),
  ).toThrow();
});

it.each([
  {
    name: "text with null tool calls",
    message: { content: "OK", tool_calls: null },
    text: "OK",
    stop: "end_turn",
  },
  {
    name: "refusal without content",
    message: { content: null, refusal: "Cannot help with this request." },
    text: "Cannot help with this request.",
    stop: "end_turn",
  },
])("preserves $name from non-streamed completions", ({ message, text, stop }) => {
  expect(
    fromChatCompletion(
      { id: "completion", choices: [{ finish_reason: "stop", message }] },
      "Exact-model",
    ),
  ).toMatchObject({ model: "Exact-model", content: [{ type: "text", text }], stop_reason: stop });
});
