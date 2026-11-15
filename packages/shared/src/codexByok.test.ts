import { describe, expect, it, vi } from "vite-plus/test";
import {
  codexConnectionMode,
  codexRuntimeSource,
  codexByokUrlError,
  withCodexByokVariable,
  codexByokLaunchArgs,
} from "./codexByok.ts";

describe("Codex connection configuration", () => {
  it("preserves legacy login sources while changing only the executable source", () => {
    expect(codexConnectionMode({ setupMode: "managed" })).toBe("chatgpt");
    expect(codexConnectionMode({})).toBe("existing");
    expect(codexRuntimeSource({ setupMode: "managed" })).toBe("auto");
    expect(codexRuntimeSource({})).toBe("local");
    for (const connectionMode of ["chatgpt", "existing", "byok"] as const) {
      for (const runtimeSource of ["managed", "local"] as const) {
        expect(codexConnectionMode({ connectionMode, runtimeSource })).toBe(connectionMode);
        expect(codexRuntimeSource({ connectionMode, runtimeSource })).toBe(runtimeSource);
      }
    }
  });
  it("rejects credential-bearing and request URLs without losing gateway prefixes", () => {
    using _parse = vi.spyOn(URL, "parse").mockImplementation(() => {
      throw new TypeError("URL.parse is not available in this client");
    });
    expect(codexByokUrlError("https://gateway.example/team/v1")).toBeNull();
    for (const url of [
      "file:///tmp/api",
      "https://key@api.example",
      "https://api.example/v1/responses",
      "https://api.example?key=secret",
      "bad",
    ]) {
      expect(codexByokUrlError(url)).not.toBeNull();
    }
    const args = codexByokLaunchArgs("https://gateway.example/team/v1/");
    expect(args).toContain("gateway.example/team/v1");
    expect(args).toContain("T3_CODEX_API_KEY");
    const customPath = codexByokLaunchArgs("https://gateway.example/team/api/");
    expect(customPath).toContain("model_catalog_url");
    expect(customPath).toContain("https://gateway.example/team/api/models");
    expect(customPath).not.toContain("/api/v1/");
    expect(args).not.toContain("openai_token_sharing");
  });
  it("preserves a redacted key when editing the endpoint and marks replacement keys sensitive", () => {
    const key = { name: "T3_CODEX_API_KEY", value: "", valueRedacted: true, sensitive: true };
    const edited = withCodexByokVariable([key], "T3_CODEX_BASE_URL", "https://api.example/v1");
    expect(edited[0]).toEqual(key);
    expect(withCodexByokVariable(edited, "T3_CODEX_API_KEY", "replacement")).toContainEqual({
      name: "T3_CODEX_API_KEY",
      value: "replacement",
      sensitive: true,
    });
  });
});
