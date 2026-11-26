import * as Effect from "effect/Effect";
import { noiseHostPublicKey, initializeConnectNoise } from "@t3tools/shared/connectNoiseWasm";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ServerSecretStore } from "./ServerSecretStore.ts";

export const noiseHostKeyName = "connect-noise-v1.key";
export const noiseHostIdentity = Effect.gen(function* () {
  const id = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const key = yield* (yield* ServerSecretStore).getOrCreateRandom(noiseHostKeyName, 32);
  yield* Effect.promise(initializeConnectNoise);
  return { env: id, pin: Buffer.from(noiseHostPublicKey(key)).toString("base64url") };
});
