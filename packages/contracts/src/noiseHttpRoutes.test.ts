import { expect, it } from "vite-plus/test";
import { isNoiseHttpRoute } from "./noiseHttpRoutes.ts";

it.each([
  ["POST", "/api/auth/connect-devices/approve", true],
  ["GET", "/api/auth/connect-devices/approve", false],
  ["POST", "/api/auth/websocket-ticket/media", false],
  ["POST", "/api/auth/browser-session", false],
  ["POST", "/oauth/token", false],
  ["GET", "/api/voice/models?benchmarks=1", true],
  ["POST", "/api/voice/cloud/openrouter/transcribe?model=author%2Fmodel", true],
  ["POST", "/api/voice/cloud/unknown/transcribe", false],
  ["GET", "/api/orchestration/threads/peer%20thread/transcript", true],
  ["GET", "/api/orchestration/threads/import%3Aclaude%2Forc%20lead/transcript", true],
  ["GET", "/api/orchestration/threads/a/extra/transcript", false],
  ["GET", "/api/preview/tunnel", false],
] as const)("checks %s %s", (method, path, allowed) => {
  expect(isNoiseHttpRoute(method, new URL(path, "https://noise.invalid"))).toBe(allowed);
});
