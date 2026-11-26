// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exercise extension negotiation on a real WebSocket listener.
import * as NodeHttp from "node:http";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CONNECT_NOISE_PATH,
  EnvironmentId,
  connectDeviceVerificationCode,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import * as Schema from "effect/Schema";
import { openPinnedNoiseClient } from "./pinnedNoiseClient.ts";
import { decideNoiseDevice } from "../cli/runningServer.ts";
import { LOCAL_NOISE_DEVICE_SUBJECT } from "./SessionStore.ts";
import {
  AuthAccessWriteScope,
  AuthAccessReadScope,
  LocalDeviceNoiseRequest,
  LocalDeviceNoiseReply,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { connectNoiseClient } from "./connectNoise.testkit.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { routeLayer, createNoisePin } from "./connectNoise.ts";

it.live(
  "binds device approval to the pinned Noise handshake and honors revocation on the next connection",
  () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const disabled = ManagedPolicy.layerTest({
        schemaVersion: 1,
        organization: "test",
        limits: { connect: false },
      });
      const policyError = yield* createNoisePin().pipe(Effect.provide(disabled), Effect.flip);
      assert.equal(policyError._tag, "ManagedPolicyRefusedError");
      const pin = new URL(yield* createNoisePin());
      assert.equal(yield* createNoisePin(), pin.href);
      const device = makeDpopKey();
      const issue = () =>
        grants.issueOneTimeToken({
          subject: "cloud-connect",
          proofKeyThumbprint: device.thumbprint,
        });
      const grant = yield* issue();
      const services = yield* Layer.build(
        HttpRouter.serve(
          routeLayer(() => Effect.die("Approval probes cannot start RPC")),
          { disableListenLog: true },
        ).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(NodeHttp.createServer, {
              port: 0,
              host: "127.0.0.1",
              websocket: { perMessageDeflate: true },
            }),
          ),
        ),
      );
      const url =
        HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address).replace(
          /^http/,
          "ws",
        ) + CONNECT_NOISE_PATH;
      const request = (credential: string, options?: Parameters<typeof connectNoiseClient>[4]) =>
        connectNoiseClient(url, pin, device, credential, options).pipe(
          Effect.map((connection) => connection.reply),
          Effect.scoped,
        );
      assert.deepEqual(yield* request(grant.credential, { wrongNonce: true }), {
        status: "rejected",
      });
      assert.deepEqual(yield* request(grant.credential), {
        status: "pending",
        verificationCode: connectDeviceVerificationCode(device.thumbprint),
      });
      const origin = new URL(url).origin.replace(/^ws/, "http");
      const args = new URLSearchParams(pin.hash.slice(1));
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const encode = Schema.encodeEffect(Schema.fromJsonString(LocalDeviceNoiseRequest));
      const decode = Schema.decodeEffect(Schema.fromJsonString(LocalDeviceNoiseReply));
      for (const [subject, scopes] of [
        ["ordinary", [AuthAccessWriteScope]],
        [LOCAL_NOISE_DEVICE_SUBJECT, [AuthAccessReadScope]],
      ] as const) {
        const issued = yield* environmentAuth.issueSession({ subject, scopes });
        const client = yield* openPinnedNoiseClient(origin, args.get("env")!, args.get("pin")!);
        const payload = yield* encode({
          mode: "local-device",
          action: "approve",
          target: grant.id,
          token: issued.token,
        });
        const reply = yield* decode(
          new TextDecoder().decode(yield* client.exchange(Buffer.from(payload))),
        );
        assert.deepEqual(reply, { status: "rejected" });
        if (subject === LOCAL_NOISE_DEVICE_SUBJECT)
          assert.isTrue(
            yield* Effect.isFailure(
              environmentAuth.authenticateHttpRequest(
                HttpServerRequest.fromWeb(
                  new Request("http://localhost", {
                    headers: { authorization: "Bearer " + issued.token },
                  }),
                ),
              ),
            ),
          );
      }
      assert.isTrue(
        yield* decideNoiseDevice(origin, { action: "approve", target: grant.id }).pipe(
          Effect.scoped,
        ),
      );
      for (const options of [
        { mode: "rpc" as const },
        { mode: "rpc" as const, orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 },
      ]) {
        assert.deepEqual(yield* request(grant.credential, options), { status: "rejected" });
      }
      assert.deepEqual(yield* request(grant.credential), { status: "approved" });
      assert.deepEqual(yield* request(grant.credential), { status: "rejected" });
      assert.isTrue(
        yield* decideNoiseDevice(origin, { action: "revoke", target: device.thumbprint }).pipe(
          Effect.scoped,
        ),
      );
      assert.deepEqual(yield* request((yield* issue()).credential), {
        status: "pending",
        verificationCode: connectDeviceVerificationCode(device.thumbprint),
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            Layer.succeed(ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("noise-test")),
            }),
          ),
          Layer.provideMerge(ManagedPolicy.layerTest()),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "noise-approval-" })),
          Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer)),
        ),
      ),
    ),
);
