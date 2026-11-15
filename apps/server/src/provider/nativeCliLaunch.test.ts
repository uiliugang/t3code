import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { nativeCliArguments, parseNativeCliArguments } from "./nativeCliLaunch.ts";

const selection = {
  instanceId: ProviderInstanceId.make("codex_byok"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};

describe("native terminal CLI arguments", () => {
  it("keeps native arguments intact and honors explicit model options before the separator", () => {
    expect(nativeCliArguments("codex", selection, ["--model=custom", "a b"])).toEqual([
      "-c",
      'model_reasoning_effort="high"',
      "--model=custom",
      "a b",
    ]);
    expect(nativeCliArguments("codex", selection, ["--", "--model=prompt"])).toEqual([
      "--model",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="high"',
      "--",
      "--model=prompt",
    ]);
    expect(nativeCliArguments("claude", selection, ["--model", "opus"])).toEqual([
      "--model",
      "opus",
    ]);
    expect(
      nativeCliArguments(
        "codex",
        { ...selection, options: [] },
        ["-mcustom"],
        ["--model", "old", "--profile", "work"],
      ),
    ).toEqual(["--profile", "work", "-mcustom"]);
    expect(
      nativeCliArguments("claude", { ...selection, options: [{ id: "effort", value: "high" }] }, [
        "--model",
        "opus",
      ]),
    ).toEqual(["--effort", "high", "--model", "opus"]);
    expect(nativeCliArguments("codex", selection, ["-c", 'model_reasoning_effort="low"'])).toEqual([
      "--model",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="low"',
    ]);
  });

  it("consumes only the explicit T3 instance selector", () => {
    expect(
      parseNativeCliArguments([
        "--t3-instance",
        "claude_work",
        "--model",
        "opus",
        "--",
        "--t3-instance=x",
      ]),
    ).toEqual({
      instanceId: "claude_work",
      args: ["--model", "opus", "--", "--t3-instance=x"],
    });
    expect(() => parseNativeCliArguments(["--t3-instance"])).toThrow();
  });
});
