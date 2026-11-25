// @effect-diagnostics nodeBuiltinImport:off - This developer command reads local credential files.
import * as NodeFSP from "node:fs/promises";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as RelayConfiguration from "../src/Config.ts";
import * as WebCrypto from "../src/WebCrypto.ts";
import * as FcmAssertionSigner from "../src/agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "../src/agentActivity/FcmClient.ts";

const Device = Schema.Struct({
  token: Schema.NonEmptyString,
  deviceId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  packageName: Schema.NonEmptyString,
  environmentId: Schema.NonEmptyString,
});
const decodeDevice = Schema.decodeUnknownEffect(Schema.fromJsonString(Device));
class SmokeUsageError extends Schema.TaggedError<
  SmokeUsageError,
  { readonly brand: unique symbol }
>()("SmokeUsageError", {}) {
  override get message() {
    return "Usage: node scripts/android-push-smoke.ts <service-account.json> <device.json>";
  }
}

class SmokeCredentialReadError extends Schema.TaggedError<
  SmokeCredentialReadError,
  { readonly brand: unique symbol }
>()("SmokeCredentialReadError", { cause: Schema.Defect() }) {
  override get message() {
    return "Could not read service-account file.";
  }
}

class SmokeDeviceReadError extends Schema.TaggedError<
  SmokeDeviceReadError,
  { readonly brand: unique symbol }
>()("SmokeDeviceReadError", { cause: Schema.Defect() }) {
  override get message() {
    return "Could not read device file.";
  }
}

class SmokeUnregisteredDeviceError extends Schema.TaggedError<
  SmokeUnregisteredDeviceError,
  { readonly brand: unique symbol }
>()("SmokeUnregisteredDeviceError", {}) {
  override get message() {
    return "This device token is no longer registered with Firebase.";
  }
}

const main = Effect.gen(function* () {
  const [credentialPath, devicePath, ...extra] = process.argv.slice(2);
  if (!credentialPath || !devicePath || extra.length) return yield* new SmokeUsageError({});
  const credentials = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(credentialPath, "utf8"),
    catch: (cause) => new SmokeCredentialReadError({ cause }),
  });
  const device = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(devicePath, "utf8"),
    catch: (cause) => new SmokeDeviceReadError({ cause }),
  }).pipe(Effect.flatMap(decodeDevice));
  const config: RelayConfiguration.RelayConfiguration["Service"] = {
    relayIssuer: "http://localhost",
    fcmServiceAccount: Redacted.make(credentials),
    apns: null,
    clerkSecretKey: Redacted.make(""),
    clerkPublishableKey: "",
    clerkJwtAudience: "",
    apnsDeliveryJobSigningSecret: Redacted.make(""),
    cloudMintPrivateKey: Redacted.make(""),
    cloudMintPublicKey: "",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
  };
  const result = yield* FcmClient.FcmClient.pipe(
    Effect.flatMap((client) => client.sendWake(device)),
    Effect.provide(
      FcmClient.layer.pipe(
        Layer.provide(
          FcmAssertionSigner.layer.pipe(
            Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RelayConfiguration.RelayConfiguration, config),
            FetchHttpClient.layer,
          ),
        ),
      ),
    ),
  );
  if (result.unregistered) return yield* new SmokeUnregisteredDeviceError({});
  yield* Effect.logInfo("Firebase accepted the wake. Verify the host activity on the device.");
});

NodeRuntime.runMain(main);
