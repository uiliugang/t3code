// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hook address rendering needs a synchronous keyed alias for each row.
import * as NodeCrypto from "node:crypto";
import { CompactEncrypt, compactDecrypt, importJWK } from "jose";
import * as Schema from "effect/Schema";
import { initializeConnectNoise, noiseHostPublicKey } from "@t3tools/shared/connectNoiseWasm";

export const encryptedHookPath = /^\/api\/hooks\/[a-zA-Z0-9_-]{43}\/encrypted-v1$/u;
function hookAlias(hookId: string, token: string, pin: string) {
  return NodeCrypto.createHmac("sha256", token)
    .update("t3-webhook-v1\0")
    .update(pin)
    .update("\0")
    .update(hookId)
    .digest("base64url");
}
export const WEBHOOK_KEY_NAME = "webhook-seal-v1.key";
const typ = "t3-webhook+jwe";
const maxAge = 24 * 60 * 60 * 1000;
const Envelope = Schema.Struct({
  hookId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  token: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  id: Schema.String.check(Schema.isUUID()),
  createdAt: Schema.Int,
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH"]),
  headers: Schema.Record(Schema.String, Schema.String),
  query: Schema.String,
  body: Schema.Uint8ArrayFromBase64,
});
export type EncryptedHookDelivery = typeof Envelope.Type;
const encode = Schema.encodeSync(Schema.fromJsonString(Envelope));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope));

export async function webhookPublicKey(secret: Uint8Array) {
  await initializeConnectNoise();
  return Buffer.from(noiseHostPublicKey(secret)).toString("base64url");
}

export function encryptedWebhookAddress(base: string, hookId: string, token: string, pin: string) {
  const endpoint = new URL(base + "/" + hookAlias(hookId, token, pin) + "/encrypted-v1");
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error("HTTPS webhook endpoint required.");
  const fragment = new URLSearchParams({ pin, hook: hookId, token });
  return `t3hook://${endpoint.host}${endpoint.pathname}#${fragment}`;
}

export async function encryptWebhook(
  address: string,
  request: Omit<EncryptedHookDelivery, "hookId" | "token">,
) {
  const url = new URL(address);
  if (
    url.protocol !== "t3hook:" ||
    url.username ||
    url.password ||
    url.search ||
    !url.pathname.endsWith("/encrypted-v1")
  )
    throw new Error("Invalid encrypted webhook address.");
  const params = new URLSearchParams(url.hash.slice(1));
  const pin = params.get("pin");
  const token = params.get("token");
  const hookId = params.get("hook");
  if (!pin || !/^[a-zA-Z0-9_-]{43}$/.test(pin) || !token || !hookId)
    throw new Error("Incomplete encrypted webhook address.");
  if (url.pathname.split("/").at(-2) !== hookAlias(hookId, token, pin))
    throw new Error("Invalid encrypted webhook address.");
  const key = await importJWK({ kty: "OKP", crv: "X25519", x: pin }, "ECDH-ES");
  const bytes = new TextEncoder().encode(encode({ ...request, token, hookId }));
  const body = await new CompactEncrypt(bytes)
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", typ })
    .encrypt(key);
  if (body.length > 1024 * 1024) throw new Error("Encrypted delivery exceeds the webhook limit.");
  return { url: `https://${url.host}${url.pathname}`, body };
}

export async function decryptWebhook(
  secret: Uint8Array,
  ciphertext: Uint8Array,
  now: number,
  alias: string,
) {
  const pin = await webhookPublicKey(secret);
  const key = await importJWK(
    {
      kty: "OKP",
      crv: "X25519",
      x: pin,
      d: Buffer.from(secret).toString("base64url"),
    },
    "ECDH-ES",
  );
  const { plaintext, protectedHeader } = await compactDecrypt(ciphertext, key, {
    maxDecompressedLength: 0,
    keyManagementAlgorithms: ["ECDH-ES"],
    contentEncryptionAlgorithms: ["A256GCM"],
  });
  if (protectedHeader.typ !== typ || protectedHeader.zip !== undefined)
    throw new Error("Invalid encrypted webhook.");
  const delivery = decode(new TextDecoder().decode(plaintext));
  if (alias !== hookAlias(delivery.hookId, delivery.token, pin))
    throw new Error("Invalid webhook destination.");
  if (delivery.createdAt > now + 60_000 || delivery.createdAt < now - maxAge)
    throw new Error("Expired encrypted webhook.");
  return delivery;
}
