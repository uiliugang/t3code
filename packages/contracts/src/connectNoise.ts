import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { EnvironmentId } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";
import { AuthGrantScopes, ServerAuthDescriptor } from "./auth.ts";

export const CONNECT_NOISE_PATH = "/api/connect/e2ee/v1";
export const connectNoiseProofUrl = (environmentId: string) =>
  `https://t3.invalid/environments/${encodeURIComponent(environmentId)}${CONNECT_NOISE_PATH}`;

const decodeEnvironment = Schema.decodeOption(EnvironmentId);
const pairingPrefix = "t3noise://pair#";

export function readNoisePin(value: string) {
  if (!value.startsWith(pairingPrefix)) return null;
  const params = new URLSearchParams(value.slice(pairingPrefix.length));
  const environment = params.get("env");
  const encoded = params.get("pin");
  if (
    !environment ||
    environment.length > 128 ||
    encoded?.length !== 43 ||
    params.getAll("env").length !== 1 ||
    params.getAll("pin").length !== 1
  )
    return null;
  const key = Base64Url.decode(encoded);
  const id = decodeEnvironment(environment);
  if (
    Result.isFailure(key) ||
    key.success.length !== 32 ||
    Base64Url.encode(key.success) !== encoded ||
    Option.isNone(id)
  )
    return null;
  return { environmentId: id.value, key: key.success };
}

export const ConnectNoiseRequest = Schema.Struct({
  credential: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  mode: Schema.optionalKey(Schema.Literals(["rpc", "media"])),
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  proof: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8192)),
});
export const ConnectNoiseResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), verificationCode: Schema.String }),
  Schema.Struct({ status: Schema.Literal("approved") }),
  Schema.Struct({
    status: Schema.Literal("connected"),
    scopes: AuthGrantScopes,
    auth: ServerAuthDescriptor,
    expiresAt: Schema.DateTimeUtcFromString,
    orchestrationProtocolVersion: Schema.Int,
  }),
  Schema.Struct({ status: Schema.Literal("rejected") }),
]);
export type ConnectNoiseResult = typeof ConnectNoiseResult.Type;

const headers = Schema.Record(Schema.String, Schema.String);
export const NoiseMediaControl = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("http"),
    method: Schema.Literals(["GET", "HEAD", "POST"]),
    path: Schema.String,
    headers: Schema.optionalKey(headers),
  }),
  Schema.Struct({ op: Schema.Literal("ws"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("response"), status: Schema.Int, headers }),
  Schema.Struct({ op: Schema.Literal("open") }),
  Schema.Struct({ op: Schema.Literal("end") }),
  Schema.Struct({
    op: Schema.Literal("close"),
    code: Schema.optionalKey(Schema.Int),
    reason: Schema.optionalKey(Schema.String),
  }),
]);
export type NoiseMediaControl = typeof NoiseMediaControl.Type;
export const NOISE_MEDIA_MAX_MESSAGE_BYTES = 16 * 1024 * 1024 - 1;
const maxControlBytes = 32 * 1024;
const decodeControl = Schema.decodeOption(Schema.fromJsonString(NoiseMediaControl));
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encode = new TextEncoder();
function tagged(tag: number, bytes: Uint8Array) {
  const frame = new Uint8Array(bytes.length + 1);
  frame[0] = tag;
  frame.set(bytes, 1);
  return frame;
}
export const encodeNoiseMediaControl = (control: NoiseMediaControl) =>
  tagged(0, encode.encode(JSON.stringify(control)));
export const encodeNoiseMediaData = (data: Uint8Array | string) =>
  typeof data === "string" ? tagged(2, encode.encode(data)) : tagged(1, data);
export function decodeNoiseMediaFrame(frame: Uint8Array) {
  if (!frame.length || frame.length > NOISE_MEDIA_MAX_MESSAGE_BYTES + 1) return null;
  const content = frame.subarray(1);
  if (frame[0] === 1) return { kind: "binary", bytes: content } as const;
  try {
    if (frame[0] === 2) return { kind: "text", text: utf8.decode(content) } as const;
    if (frame[0] !== 0 || content.length > maxControlBytes) return null;
    const decoded = decodeControl(utf8.decode(content));
    return decoded._tag === "Some" ? ({ kind: "control", control: decoded.value } as const) : null;
  } catch {
    return null;
  }
}

export const LocalDeviceDecision = Schema.Struct({
  action: Schema.Literals(["approve", "deny", "revoke"]),
  target: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
});
export type LocalDeviceDecision = typeof LocalDeviceDecision.Type;
export const LocalDeviceNoiseRequest = Schema.Struct({
  mode: Schema.Literal("local-device"),
  token: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8192)),
  ...LocalDeviceDecision.fields,
});
export type LocalDeviceNoiseRequest = typeof LocalDeviceNoiseRequest.Type;
export const LocalDeviceNoiseReply = Schema.Union([
  Schema.Struct({ status: Schema.Literal("decided"), changed: Schema.Boolean }),
  Schema.Struct({ status: Schema.Literal("rejected") }),
]);
