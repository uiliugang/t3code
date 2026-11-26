// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityPublishRequest,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { RELAY_ACTIVITY_PUBLISH_TYP, RELAY_ACTIVITY_WAKE_TYP } from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentPublishSignatures from "./EnvironmentPublishSignatures.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-05-25T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const isEnvironmentPublishSignatureInvalid = Schema.is(
  EnvironmentPublishSignatures.EnvironmentPublishSignatureInvalid,
);

function signTestJwt(
  payload: object,
  privateKey: string,
  typ = RELAY_ACTIVITY_PUBLISH_TYP,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const freshRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const payload = {
    iss: "t3-env:env",
    aud: "https://relay.example.test",
    sub: "env",
    jti: "publish-jti",
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.add(now, { minutes: 5 }).epochMilliseconds / 1_000),
    environmentId: state.environmentId,
    threadId: state.threadId,
    state,
  } satisfies RelayAgentActivityPublishProofPayload;
  return {
    state,
    proof: signTestJwt(payload, keyPair.privateKey),
  } satisfies RelayAgentActivityPublishRequest;
});

function layer(replay?: Partial<DpopProofs.DpopProofReplay["Service"]>) {
  return EnvironmentPublishSignatures.layer.pipe(
    Layer.provide(
      Layer.merge(
        RelayConfiguration.layer(config),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume:
            replay?.verifyAndConsume ?? (() => Effect.die("unexpected DPoP proof verification")),
          consume: replay?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: replay?.pruneExpired ?? Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer)),
  );
}

describe("EnvironmentPublishSignatures", () => {
  it.effect("verifies activity JWTs and scopes replay storage to the environment key", () => {
    let replayThumbprint: string | null = null;
    return Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      yield* signatures.verify({
        environmentId: state.environmentId,
        environmentPublicKey: keyPair.publicKey,
        threadId: state.threadId,
        request,
      });
      expect(replayThumbprint).toBe(
        `env-publish:${NodeCrypto.createHash("sha256")
          .update(
            stableStringify({
              environmentId: state.environmentId,
              environmentPublicKey: keyPair.publicKey,
            }),
          )
          .digest("base64url")}`,
      );
    }).pipe(
      Effect.provide(
        layer({
          consume: (input) =>
            Effect.sync(() => {
              replayThumbprint = input.thumbprint;
              return true;
            }),
        }),
      ),
    );
  });

  it.effect(
    "accepts an environment wake only under the wake signing purpose and consumes its nonce",
    () => {
      const consumed = new Set<string>();
      return Effect.gen(function* () {
        const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
        const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
        const claims = {
          environmentId: state.environmentId,
          iss: "t3-env:env",
          aud: config.relayIssuer,
          sub: "env",
          iat: now,
          exp: now + 300,
          jti: "wake",
        };
        const verify = (proof: string) =>
          signatures.verify({
            environmentId: "env",
            environmentPublicKey: keyPair.publicKey,
            request: { proof },
          });
        expect((yield* verify((yield* freshRequest).proof).pipe(Effect.flip))._tag).toBe(
          "EnvironmentPublishSignatureInvalid",
        );
        const proof = signTestJwt(claims, keyPair.privateKey, RELAY_ACTIVITY_WAKE_TYP);
        yield* verify(proof);
        expect(yield* verify(proof).pipe(Effect.flip)).toMatchObject({ reason: "replayed_nonce" });
        expect(
          yield* verify(
            signTestJwt(
              { ...claims, environmentId: "another" },
              keyPair.privateKey,
              RELAY_ACTIVITY_WAKE_TYP,
            ),
          ).pipe(Effect.flip),
        ).toMatchObject({ stage: "validate_claims" });
        expect(
          yield* signatures
            .verify({
              environmentId: "env",
              environmentPublicKey: keyPair.publicKey,
              threadId: "thread",
              request: { proof, state: null },
            })
            .pipe(Effect.flip),
        ).toMatchObject({ stage: "verify_proof" });
      }).pipe(
        Effect.provide(
          layer({
            consume: ({ jti }) =>
              Effect.sync(() => {
                if (consumed.has(jti)) return false;
                consumed.add(jti);
                return true;
              }),
          }),
        ),
      );
    },
  );

  it.effect("rejects top-level state tampering", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request: { ...request, state: { ...state, headline: "Tampered" } },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentPublishSignatureInvalid(result.failure)).toBe(true);
        if (isEnvironmentPublishSignatureInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            environmentId: state.environmentId,
            threadId: state.threadId,
            reason: "invalid_signature_or_payload",
            stage: "validate_claims",
          });
        }
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects replayed activity JWT ids", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentPublishSignatureInvalid(result.failure)).toBe(true);
        if (isEnvironmentPublishSignatureInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            environmentId: state.environmentId,
            threadId: state.threadId,
            reason: "replayed_nonce",
            stage: "consume_nonce",
          });
        }
      }
    }).pipe(Effect.provide(layer({ consume: () => Effect.succeed(false) }))),
  );
});
