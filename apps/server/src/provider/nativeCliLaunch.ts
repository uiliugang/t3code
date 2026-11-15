import type { ModelSelection } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

export function parseNativeCliArguments(input: ReadonlyArray<string>) {
  const args: string[] = [];
  let instanceId: string | undefined;
  for (let index = 0; index < input.length; index++) {
    const arg = input[index]!;
    if (arg === "--") {
      args.push(...input.slice(index));
      break;
    }
    if (arg === "--t3-instance" || arg.startsWith("--t3-instance=")) {
      const value = arg === "--t3-instance" ? input[++index] : arg.slice(14);
      if (!value || value.startsWith("-") || instanceId !== undefined)
        throw new Error("Use --t3-instance <instance-id> once.");
      instanceId = value;
    } else args.push(arg);
  }
  return { instanceId, args };
}

export function nativeCliArguments(
  command: "codex" | "claude",
  selection: ModelSelection,
  args: ReadonlyArray<string>,
  launchArgs: ReadonlyArray<string> = [],
) {
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const hasModel = flags.some(
    (arg) =>
      arg === "--model" ||
      arg.startsWith("--model=") ||
      (command === "codex" && arg.startsWith("-m")),
  );
  const defaults: string[] = hasModel ? [] : ["--model", selection.model];
  if (command === "codex") {
    for (const [id, key] of [
      ["reasoningEffort", "model_reasoning_effort"],
      ["serviceTier", "service_tier"],
    ]) {
      const value = selection.options?.find((option) => option.id === id)?.value;
      if (typeof value === "string" && !flags.some((arg) => arg.includes(`${key}=`)))
        defaults.push("-c", `${key}=${JSON.stringify(value)}`);
    }
  } else {
    const effort = selection.options?.find((option) => option.id === "effort")?.value;
    if (
      typeof effort === "string" &&
      !flags.some((arg) => arg === "--effort" || arg.startsWith("--effort="))
    )
      defaults.push("--effort", effort);
  }
  const configured: string[] = [];
  for (let index = 0; index < launchArgs.length; index++) {
    const arg = launchArgs[index]!;
    if (arg === "--model" || (command === "codex" && arg === "-m")) {
      index++;
      continue;
    }
    if (arg.startsWith("--model=") || (command === "codex" && arg.startsWith("-m"))) continue;
    configured.push(arg);
  }
  return [...configured, ...defaults, ...args];
}

export function explicitNativeModel(command: "codex" | "claude", args: ReadonlyArray<string>) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg === "--model" || (command === "codex" && arg === "-m")) return args[index + 1];
    if (arg.startsWith("--model=")) return arg.slice(8);
    if (command === "codex" && arg.startsWith("-m")) return arg.slice(2).replace(/^=/, "");
  }
  return undefined;
}

export const isNativeCliCredential = (key: string) =>
  /^(OPENAI_|ANTHROPIC_|CLAUDE_|T3_CODEX_|CODEX_HOME$|CLAUDECODE$|ELECTRON_RUN_AS_NODE$)/.test(key);

export function codexNativeLaunch(runtime: {
  readonly config: {
    readonly binaryPath: string;
    readonly homePath: string;
    readonly launchArgs: string;
  };
  readonly environment: NodeJS.ProcessEnv;
}) {
  return {
    command: runtime.config.binaryPath,
    args: tokenizeCliArgs(resolveCodexLaunchArgs(runtime.config.launchArgs, runtime.environment)),
    environment: {
      ...runtime.environment,
      CODEX_HOME: runtime.config.homePath || runtime.environment.CODEX_HOME,
    },
  };
}
