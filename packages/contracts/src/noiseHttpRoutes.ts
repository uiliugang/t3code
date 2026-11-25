const readPaths = new Set([
  "/api/voice/cloud/keys",
  "/api/voice/cloud/openrouter/models",
  "/api/voice/status",
  "/api/voice/models",
]);

const writePaths = new Set([
  "/api/pull-requests/diff",
  "/api/auth/pairing-token",
  "/api/auth/pairing-links/revoke",
  "/api/auth/clients/revoke",
  "/api/auth/clients/revoke-others",
  "/api/auth/connect-devices/approve",
  "/api/auth/connect-devices/revoke",
  "/api/voice/models/prepare",
  "/api/voice/models/download",
  "/api/voice/models/select",
  "/api/voice/models/cancel",
  "/api/voice/models/remove",
  "/api/voice/models/link",
  "/api/voice/acceleration",
  "/api/voice/model-unload-timeout",
  "/api/voice/transcribe",
  "/api/voice/post-process",
]);

/** Only finite environment API calls can reuse the principal authenticated by Noise. */
export function isNoiseHttpRoute(method: string, url: URL): boolean {
  const path = url.pathname;
  if (method === "GET") {
    return readPaths.has(path) || /^\/api\/orchestration\/threads\/[^/]+\/transcript$/.test(path);
  }
  return (
    method === "POST" &&
    (writePaths.has(path) ||
      /^\/api\/voice\/cloud\/(openai|xai|openrouter)\/(key|transcribe)$/.test(path))
  );
}
