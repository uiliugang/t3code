import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { prefersHttpMcpTransport } from "./mcpTransport.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const local = (commandPath: string, commandArgs: string[] = []) =>
  decodeSettings({ source: "local", commandPath, commandArgs });

describe("prefersHttpMcpTransport", () => {
  it("uses HTTP for the vendored Command Code launcher", () => {
    expect(
      prefersHttpMcpTransport(
        local("/usr/local/bin/node", [
          "/home/me/.t3/bin/cmdcode/node_modules/command-code/dist/index.mjs",
          "acp",
        ]),
      ),
    ).toBe(true);
    expect(
      prefersHttpMcpTransport(
        local("/usr/local/bin/node", ["/src/command-code/dist/cli.mjs", "acp"]),
      ),
    ).toBe(true);
  });

  it("uses HTTP for the global Command Code executable", () => {
    expect(prefersHttpMcpTransport(local("/usr/local/bin/cmdc"))).toBe(true);
  });

  it("keeps the stdio bridge for other local agents", () => {
    expect(
      prefersHttpMcpTransport(
        local("/usr/local/bin/node", ["/tools/some-other-agent/dist/index.mjs", "acp"]),
      ),
    ).toBe(false);
    expect(prefersHttpMcpTransport(local("/usr/local/bin/claude-agent-acp"))).toBe(false);
    expect(prefersHttpMcpTransport(local("/tools/command-code/runner.mjs"))).toBe(false);
  });

  it("keeps the stdio bridge for registry agents", () => {
    expect(
      prefersHttpMcpTransport(decodeSettings({ source: "registry", agentId: "claude-acp" })),
    ).toBe(false);
  });
});
