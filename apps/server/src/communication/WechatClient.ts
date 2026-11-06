import { WechatError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const API_BASE = "https://ilinkai.weixin.qq.com";
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const Qr = Schema.Struct({ qrcode: Schema.String, qrcode_img_content: Schema.String });
const Login = Schema.Struct({
  status: Schema.String,
  bot_token: Schema.optional(Schema.String),
  ilink_bot_id: Schema.optional(Schema.String),
  ilink_user_id: Schema.optional(Schema.String),
  baseurl: Schema.optional(Schema.String),
  redirect_host: Schema.optional(Schema.String),
});
const Inbound = Schema.Struct({
  message_id: Schema.Union([Schema.String, Schema.Number]),
  from_user_id: Schema.String,
  create_time_ms: Schema.optional(Schema.Number),
  message_type: Schema.Number,
  group_id: Schema.optional(Schema.String),
  context_token: Schema.optional(Schema.String),
  item_list: Schema.Array(
    Schema.Struct({
      type: Schema.Number,
      text_item: Schema.optional(Schema.Struct({ text: Schema.String })),
    }),
  ),
});
const Updates = Schema.Struct({
  msgs: Schema.optional(Schema.Array(Schema.Unknown)),
  get_updates_buf: Schema.optional(Schema.String),
});
type Account = { baseUrl: string; token: string };

export function wechatApiBase(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === "ilinkai.weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com")) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new WechatError({ reason: "protocol" });
  return url.origin;
}

export class WechatClient extends Context.Service<
  WechatClient,
  {
    readonly begin: Effect.Effect<typeof Qr.Type, WechatError>;
    readonly login: (input: {
      baseUrl: string;
      qrcode: string;
      code?: string;
    }) => Effect.Effect<typeof Login.Type, WechatError>;
    readonly updates: (
      account: Account,
      cursor: string,
    ) => Effect.Effect<
      { messages: ReadonlyArray<typeof Inbound.Type>; cursor: string },
      WechatError
    >;
    readonly send: (
      account: Account,
      input: { userId: string; contextToken?: string; clientId: string; text: string },
    ) => Effect.Effect<void, WechatError>;
  }
>()("t3/communication/WechatClient") {}

const make = Effect.gen(function* () {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const random = yield* SecureRandom.SecureRandom;
  const request = Effect.fn("WechatClient.request")(function* (
    base: string,
    path: string,
    body: Record<string, unknown> | undefined,
    token?: string,
  ) {
    const baseUrl = yield* Effect.try({
      try: () => wechatApiBase(base),
      catch: () => new WechatError({ reason: "protocol" }),
    });
    const uin = yield* random.uuidV4();
    const url = `${baseUrl}/ilink/bot${path}`;
    const req = (
      body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    ).pipe(
      HttpClientRequest.setHeaders({
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "65536",
        ...(body === undefined
          ? {}
          : {
              AuthorizationType: "ilink_bot_token",
              "X-WECHAT-UIN": Buffer.from(String(Number.parseInt(uin.slice(0, 8), 16))).toString(
                "base64",
              ),
            }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }),
    );
    const payload = yield* http
      .execute(body === undefined ? req : req.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(JsonObject)),
        Effect.scoped,
        Effect.timeout(
          path === "/getupdates" ? 70000 : path.startsWith("/get_qrcode_status") ? 40000 : 20000,
        ),
        Effect.mapError(() => new WechatError({ reason: "network" })),
      );
    if (payload.ret === -14 || payload.errcode === -14)
      return yield* new WechatError({ reason: "credentials" });
    if (
      (typeof payload.ret === "number" && payload.ret !== 0) ||
      (typeof payload.errcode === "number" && payload.errcode !== 0)
    )
      return yield* new WechatError({ reason: "protocol" });
    return payload;
  });
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    value: unknown,
  ) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new WechatError({ reason: "protocol" })),
    );
  const baseInfo = { channel_version: "1.0.0", bot_agent: "T3Code/1.0.0" };
  return WechatClient.of({
    begin: request(API_BASE, "/get_bot_qrcode?bot_type=3", { local_token_list: [] }).pipe(
      Effect.flatMap((payload) => decode(Qr, payload)),
    ),
    login: Effect.fn("WechatClient.login")(function* (input) {
      return yield* request(
        input.baseUrl,
        `/get_qrcode_status?qrcode=${encodeURIComponent(input.qrcode)}${input.code ? `&verify_code=${encodeURIComponent(input.code)}` : ""}`,
        undefined,
      ).pipe(Effect.flatMap((payload) => decode(Login, payload)));
    }),
    updates: Effect.fn("WechatClient.updates")(function* (account, cursor) {
      const result = yield* request(
        account.baseUrl,
        "/getupdates",
        { get_updates_buf: cursor, base_info: baseInfo },
        account.token,
      ).pipe(
        Effect.flatMap((payload) => decode(Updates, payload)),
        Effect.timeoutOption("65 seconds"),
      );
      if (Option.isNone(result)) return { messages: [], cursor };
      const parse = Schema.decodeUnknownOption(Inbound);
      return {
        messages: (result.value.msgs ?? []).flatMap((raw) => {
          const decoded = parse(raw);
          return Option.isSome(decoded) ? [decoded.value] : [];
        }),
        cursor: result.value.get_updates_buf ?? cursor,
      };
    }),
    send: Effect.fn("WechatClient.send")(function* (account, input) {
      const result = yield* request(
        account.baseUrl,
        "/sendmessage",
        {
          base_info: baseInfo,
          msg: {
            from_user_id: "",
            to_user_id: input.userId,
            client_id: input.clientId,
            message_type: 2,
            message_state: 2,
            ...(input.contextToken ? { context_token: input.contextToken } : {}),
            item_list: [
              { type: 1, text_item: { text: input.text.replace(/\r\n|\r|\n/gu, "\r\n") } },
            ],
          },
        },
        account.token,
      );
      if (result.ret !== 0 && result.errcode !== 0)
        return yield* new WechatError({ reason: "network" });
    }),
  });
});
export const layer = Layer.effect(WechatClient, make);
