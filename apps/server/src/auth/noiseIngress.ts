import { isPeerRequest } from "../peer/noiseTrust.ts";
import { noiseGuestSession } from "./noiseGuestContext.ts";
import { encryptedHookPath } from "../scheduledTasks/encryptedWebhook.ts";
import { CONNECT_NOISE_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { noiseHttpSession } from "./noiseHttp.ts";

import { noiseOnly } from "./noiseTrust.ts";
export { noiseOnly } from "./noiseTrust.ts";

export function allowsNoiseIngress(method: string, path: string): boolean {
  return (
    (method === "GET" && path === CONNECT_NOISE_PATH) ||
    (method === "POST" &&
      (path === "/api/t3-connect/health" ||
        path === "/api/t3-connect/mint-credential" ||
        encryptedHookPath.test(path)))
  );
}

// A tunnel may itself originate on loopback. Only the in-process dispatch can vouch for a decrypted request.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    if (!(yield* noiseOnly)) return Layer.empty;
    return HttpRouter.middleware(
      (handler) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return noiseHttpSession(request) ||
            noiseGuestSession(request) ||
            isPeerRequest(request) ||
            allowsNoiseIngress(request.method, request.url)
            ? yield* handler
            : HttpServerResponse.empty({ status: 403 });
        }),
      { global: true },
    );
  }),
);
