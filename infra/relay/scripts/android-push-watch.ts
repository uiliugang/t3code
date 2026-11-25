// @effect-diagnostics nodeBuiltinImport:off - Local developer verification reads private credential files.
import * as NodeFSP from "node:fs/promises";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

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
const Connection = Schema.Struct({
  wsUrl: Schema.NonEmptyString,
  bearerToken: Schema.NonEmptyString,
});
class WatchReadFileError extends Schema.TaggedError<
  WatchReadFileError,
  { readonly brand: unique symbol }
>()("WatchReadFileError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Could not read ${this.path}`;
  }
}
const readFile = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.readFile(path, "utf8"),
    catch: (cause) => new WatchReadFileError({ path, cause }),
  });
class WatchUnregisteredDeviceError extends Schema.TaggedError<
  WatchUnregisteredDeviceError,
  { readonly brand: unique symbol }
>()("WatchUnregisteredDeviceError", {}) {
  override get message() {
    return "Device token is no longer registered";
  }
}

class WatchEnvironmentMismatchError extends Schema.TaggedError<
  WatchEnvironmentMismatchError,
  { readonly brand: unique symbol }
>()("WatchEnvironmentMismatchError", {}) {
  override get message() {
    return "The device file's environmentId must match the paired host.";
  }
}

class WatchStoppedError extends Schema.TaggedError<
  WatchStoppedError,
  { readonly brand: unique symbol }
>()("WatchStoppedError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Android push watcher stopped. Check the private connection and Firebase configuration.";
  }
}

const isWatchConfigurationError = Schema.is(
  Schema.Union([WatchUnregisteredDeviceError, WatchEnvironmentMismatchError]),
);

const main = Effect.gen(function* () {
  const [credentialsPath, devicePath, connectionPath] = process.argv.slice(2);
  if (!credentialsPath || !devicePath || !connectionPath) {
    return yield* Effect.logError(
      "Usage: node scripts/android-push-watch.ts <service-account.json> <device.json> <connection.json>",
    );
  }
  const credentials = yield* readFile(credentialsPath);
  const device = yield* readFile(devicePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Device))),
  );
  const connection = yield* readFile(connectionPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Connection))),
  );
  const layerSocketConstructor = Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeWS.WebSocket(url, protocols as string | string[] | undefined, {
        headers: { authorization: `Bearer ${connection.bearerToken}` },
      }) as unknown as globalThis.WebSocket,
  );
  const layerProtocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(connection.wsUrl).pipe(Layer.provide(layerSocketConstructor)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  const layerFcm = FcmClient.layer.pipe(
    Layer.provide(
      FcmAssertionSigner.layer.pipe(
        Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        Layer.succeed(RelayConfiguration.RelayConfiguration, {
          relayIssuer: "http://localhost",
          apns: null,
          fcmServiceAccount: Redacted.make(credentials),
          clerkSecretKey: Redacted.make(""),
          clerkPublishableKey: "",
          clerkJwtAudience: "",
          apnsDeliveryJobSigningSecret: Redacted.make(""),
          cloudMintPrivateKey: Redacted.make(""),
          cloudMintPublicKey: "",
          managedEndpointBaseDomain: undefined,
          managedEndpointNamespace: undefined,
        }),
      ),
    ),
  );
  yield* Effect.gen(function* () {
    const rpc = yield* RpcClient.make(WsRpcGroup);
    const sender = yield* FcmClient.FcmClient;
    const config = yield* rpc[WS_METHODS.serverGetConfig]({});
    if (config.environment.environmentId !== device.environmentId) {
      return yield* new WatchEnvironmentMismatchError({});
    }
    yield* Effect.logInfo("Watching the paired environment for Android activity wakes.");
    yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
      Stream.filter((item) => item.kind !== "synchronized"),
      Stream.map(() => undefined),
      Stream.groupedWithin(256, "2 seconds"),
      Stream.runForEach(() =>
        sender
          .sendWake(device)
          .pipe(
            Effect.flatMap((result) =>
              result.unregistered ? Effect.fail(new WatchUnregisteredDeviceError({})) : Effect.void,
            ),
          ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(layerProtocol, layerFcm)));
});

NodeRuntime.runMain(
  main.pipe(
    Effect.scoped,
    Effect.catchCause((cause) => {
      const failure = Cause.findErrorOption(cause);
      return Effect.fail(
        Option.isSome(failure) && isWatchConfigurationError(failure.value)
          ? failure.value
          : new WatchStoppedError({ cause }),
      );
    }),
    // Socket errors can expose credential headers; retain the cause but print only the fixed message.
    Effect.tapError((error) => Effect.logError(error.message)),
  ),
  { disableErrorReporting: true },
);
