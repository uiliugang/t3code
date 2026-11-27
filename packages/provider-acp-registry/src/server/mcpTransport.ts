import type { AcpRegistrySettings } from "../settings.ts";

const COMMAND_CODE_EXECUTABLES = /^(?:cmdc|command-code|commandcode)$/iu;
const COMMAND_CODE_ENTRY_POINTS = [
  /(?:^|[\\/])node_modules[\\/]command-code[\\/]/iu,
  /(?:^|[\\/])command-code[\\/]dist[\\/](?:index|cli)\.mjs$/iu,
];

/** Agents that use T3’s MCP endpoint over ACP HTTP. */
export function prefersHttpMcpTransport(settings: AcpRegistrySettings): boolean {
  if (settings.source !== "local") {
    return false;
  }
  const executable = settings.commandPath.split(/[\\/]/u).pop() ?? "";
  return (
    COMMAND_CODE_EXECUTABLES.test(executable) ||
    settings.commandArgs.some((argument) =>
      COMMAND_CODE_ENTRY_POINTS.some((pattern) => pattern.test(argument)),
    )
  );
}
