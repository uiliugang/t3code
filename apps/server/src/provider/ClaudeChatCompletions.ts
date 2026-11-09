import { z } from "zod";

const Text = z.object({ type: z.literal("text"), text: z.string() });
const Image = z.object({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
    z.object({ type: z.literal("url"), url: z.url() }),
  ]),
});
const Content = z.discriminatedUnion("type", [Text, Image]);
const ToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const Thinking = z.object({ type: z.literal("thinking"), thinking: z.string() });
const ToolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(Content)]).optional(),
  is_error: z.boolean().optional(),
});
export const ClaudeMessageRequest = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  stream: z.boolean().default(false),
  system: z.union([z.string(), z.array(Text)]).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.union([
          z.string(),
          z.array(z.discriminatedUnion("type", [Text, Image, ToolUse, ToolResult, Thinking])),
        ]),
      }),
    )
    .min(1),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        input_schema: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  tool_choice: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("tool"),
        name: z.string(),
        disable_parallel_tool_use: z.boolean().optional(),
      }),
      z.object({
        type: z.enum(["auto", "any", "none"]),
        disable_parallel_tool_use: z.boolean().optional(),
      }),
    ])
    .optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
});

type ChatContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type ChatConversationMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContent[] | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
};
type ChatMessage =
  | ChatConversationMessage
  | { role: "tool"; content: string; tool_call_id: string };
const contentPart = (part: z.infer<typeof Content>): ChatContent =>
  part.type === "text"
    ? { type: "text", text: part.text }
    : {
        type: "image_url",
        image_url: {
          url:
            part.source.type === "url"
              ? part.source.url
              : `data:${part.source.media_type};base64,${part.source.data}`,
        },
      };

export function toChatCompletions(input: unknown) {
  const request = ClaudeMessageRequest.parse(input);
  const messages: ChatMessage[] = [];
  if (request.system)
    messages.push({
      role: "system",
      content:
        typeof request.system === "string"
          ? request.system
          : request.system.map((part) => part.text).join("\n"),
    });
  for (const message of request.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const parts: ChatContent[] = [];
    const calls: NonNullable<ChatConversationMessage["tool_calls"]> = [];
    let reasoning = "";
    // Tool results precede the next user message, even when Claude combines them in one turn.
    for (const part of message.content) {
      switch (part.type) {
        case "tool_result": {
          const result =
            typeof part.content === "string"
              ? [{ type: "text" as const, text: part.content }]
              : (part.content ?? []);
          messages.push({
            role: "tool",
            tool_call_id: part.tool_use_id,
            content: result
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
          });
          const images = result.filter((block) => block.type === "image");
          if (images.length)
            parts.push(
              { type: "text", text: `Image from tool result ${part.tool_use_id}:` },
              ...images.map(contentPart),
            );
          break;
        }
        case "tool_use":
          calls.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          });
          break;
        case "thinking":
          reasoning += part.thinking;
          break;
        default:
          parts.push(contentPart(part));
      }
    }
    if (parts.length || calls.length || reasoning)
      messages.push({
        role: message.role,
        content: parts.length ? parts : null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      });
  }
  const choice = request.tool_choice;
  return {
    model: request.model,
    messages,
    max_tokens: request.max_tokens,
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            },
          })),
        }
      : {}),
    ...(choice
      ? {
          tool_choice:
            choice.type === "tool"
              ? { type: "function", function: { name: choice.name } }
              : choice.type === "any"
                ? "required"
                : choice.type,
        }
      : {}),
    ...(choice && choice.disable_parallel_tool_use !== undefined
      ? { parallel_tool_calls: !choice.disable_parallel_tool_use }
      : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { top_p: request.top_p }),
    ...(request.stop_sequences?.length ? { stop: request.stop_sequences } : {}),
  };
}

const Usage = z
  .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
  .nullish();
const ToolCall = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const ChatCompletion = z.object({
  id: z.string(),
  usage: Usage,
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
          reasoning_content: z.string().nullish(),
          tool_calls: z.array(ToolCall).nullish(),
        }),
      }),
    )
    .min(1),
});
export const ChatChunk = z.object({
  id: z.string().optional(),
  usage: Usage,
  choices: z.array(
    z.object({
      index: z.number(),
      finish_reason: z.string().nullable(),
      delta: z.object({
        content: z.string().nullish(),
        refusal: z.string().nullish(),
        reasoning_content: z.string().nullish(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().int().nonnegative(),
              id: z.string().optional(),
              function: z
                .object({ name: z.string().optional(), arguments: z.string().optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
    }),
  ),
});
export const stopReason = (reason: string | null) =>
  reason === "tool_calls"
    ? "tool_use"
    : reason === "length"
      ? "max_tokens"
      : reason === "stop"
        ? "end_turn"
        : "refusal";
export const usage = (value: z.infer<typeof Usage>) => ({
  input_tokens: value?.prompt_tokens ?? 0,
  output_tokens: value?.completion_tokens ?? 0,
});
export function fromChatCompletion(input: unknown, model: string) {
  const result = ChatCompletion.parse(input);
  const choice = result.choices[0]!;
  if (
    !choice.finish_reason ||
    (choice.finish_reason === "tool_calls" && !choice.message.tool_calls?.length)
  )
    throw new Error("Incomplete Chat Completions response");
  return {
    id: result.id,
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(choice.message.reasoning_content
        ? [{ type: "thinking", thinking: choice.message.reasoning_content, signature: "" }]
        : []),
      ...(choice.message.content ? [{ type: "text", text: choice.message.content }] : []),
      ...(choice.message.refusal ? [{ type: "text", text: choice.message.refusal }] : []),
      ...(choice.message.tool_calls ?? []).map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: z.record(z.string(), z.unknown()).parse(JSON.parse(call.function.arguments)),
      })),
    ],
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: usage(result.usage),
  };
}
