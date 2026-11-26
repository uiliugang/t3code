import * as Schema from "effect/Schema";

export const NOISE_HTTP_ORIGIN = "https://noise.invalid";
export const NOISE_HTTP_CHUNK_BYTES = 192 * 1024;
export const NOISE_HTTP_MAX_REQUEST_BYTES = 20 * 1024 * 1024;
export const NOISE_HTTP_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const chunk = Schema.String.check(
  Schema.isMaxLength(4 * Math.ceil(NOISE_HTTP_CHUNK_BYTES / 3)),
).pipe(Schema.decodeTo(Schema.Uint8ArrayFromBase64));
const uploadId = Schema.Int.check(Schema.isGreaterThan(0));
export const NoiseHttpUpload = Schema.Struct({
  id: uploadId,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  // An absent chunk releases an interrupted upload.
  data: Schema.optionalKey(chunk),
});
export const NoiseHttpRequest = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "DELETE"]),
  deflate: Schema.optionalKey(Schema.Literal(true)),
  path: Schema.String.check(Schema.isMaxLength(8192)),
  contentType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  protocol: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16))),
  body: Schema.optionalKey(chunk),
  uploadId: Schema.optionalKey(uploadId),
});
export const NoiseHttpPart = Schema.Union([
  Schema.Struct({ status: Schema.Int, contentType: Schema.String }),
  Schema.Struct({
    data: chunk,
    originalSize: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: NOISE_HTTP_CHUNK_BYTES })),
    ),
  }),
]);
export class NoiseHttpError extends Schema.TaggedError<
  NoiseHttpError,
  { readonly brand: unique symbol }
>()("NoiseHttpError", {
  message: Schema.String,
}) {}
