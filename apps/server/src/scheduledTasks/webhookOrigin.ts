import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { noiseOnly, NoiseCaller } from "../auth/noiseTrust.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  decodeRuntimeConfig,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { WEBHOOK_KEY_NAME, webhookPublicKey } from "./encryptedWebhook.ts";

export interface WebhookOrigin {
  readonly encrypted?: boolean;
  readonly webhookEncryptionPin?: string;
  readonly relayHookBaseUrl: string | null;
}

const ENDPOINT_KEY = /^[0-9a-f]{16}$/;

export function relayHookBaseUrl(input: {
  readonly relayUrl: string;
  readonly tunnelName: string | undefined;
}): string | null {
  const endpointKey = input.tunnelName?.split("-").at(-1);
  const relayUrl = input.relayUrl.replace(/\/+$/, "");
  if (relayUrl === "" || endpointKey === undefined || !ENDPOINT_KEY.test(endpointKey)) {
    return null;
  }
  return `${relayUrl}/v1/hooks/${endpointKey}`;
}

export class ScheduledTaskWebhookOrigin extends Context.Reference<Effect.Effect<WebhookOrigin>>(
  "t3/scheduledTasks/ScheduledTaskWebhookOrigin",
  {
    defaultValue: () => Effect.succeed({ relayHookBaseUrl: null }),
  },
) {}

export const layerScheduledTaskWebhookOrigin = Layer.effect(
  ScheduledTaskWebhookOrigin,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const strict = yield* noiseOnly;
    const loadPin = yield* Effect.cached(
      secrets.getOrCreateRandom(WEBHOOK_KEY_NAME, 32).pipe(
        Effect.flatMap((key) => Effect.promise(() => webhookPublicKey(key))),
        Effect.option,
      ),
    );
    return Effect.gen(function* () {
      const encrypted = strict || (yield* NoiseCaller);
      const [relayUrl, tunnelConfig] = yield* Effect.all([
        secrets.get(RELAY_URL_SECRET),
        secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      ]).pipe(Effect.orElseSucceed(() => [Option.none(), Option.none()] as const));
      if (Option.isNone(relayUrl) || Option.isNone(tunnelConfig)) {
        return { relayHookBaseUrl: null, encrypted };
      }
      const config = decodeRuntimeConfig(new TextDecoder().decode(tunnelConfig.value));
      const base = relayHookBaseUrl({
        relayUrl: new TextDecoder().decode(relayUrl.value),
        tunnelName: Option.isSome(config) ? config.value.tunnelName : undefined,
      });
      if (!base || !encrypted) return { relayHookBaseUrl: base, encrypted };
      const pin = yield* loadPin;
      return Option.isSome(pin) && base.startsWith("https://")
        ? { relayHookBaseUrl: base, webhookEncryptionPin: pin.value }
        : { relayHookBaseUrl: null, encrypted };
    });
  }),
);
