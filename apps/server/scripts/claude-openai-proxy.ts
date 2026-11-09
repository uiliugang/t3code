import { startClaudeChatCompletionsProxy } from "../src/provider/ClaudeChatCompletionsProxy.ts";

if (!process.env.T3_PROXY_TOKEN)
  throw new Error("Set T3_PROXY_TOKEN to a local credential before starting the standalone proxy.");

const proxy = await startClaudeChatCompletionsProxy({
  baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "",
  token: process.env.T3_PROXY_TOKEN,
  port: Number(process.env.PORT ?? 8318),
});
process.stdout.write(
  `Claude Messages proxy listening at ${proxy.baseUrl}\nUse T3_PROXY_TOKEN as the Claude BYOK credential.\n`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void proxy.close();
  });
