import {
  DaxiangSendError,
  type DaxiangLinkInput,
  type DaxiangSendResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { SignJWT } from "jose";
import * as ServerSettings from "../serverSettings.ts";

const TOKEN_URL = "https://ssosv.sankuai.com/sson/auth/oidc/v1/token";
const encodeText = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);
const API_URL = "https://xopen.sankuai.com";
const isDaxiangSendError = Schema.is(DaxiangSendError);
const Status = Schema.Struct({ code: Schema.Number });
const TokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number });
const IdentityResponse = Schema.Struct({
  status: Status,
  data: Schema.optional(
    Schema.Struct({ data: Schema.Record(Schema.String, Schema.Struct({ uid: Schema.Number })) }),
  ),
});
const SendResponse = Schema.Struct({
  status: Status,
  data: Schema.optional(
    Schema.Struct({
      messageMap: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      failMap: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

export class DaxiangMessageService extends Context.Service<
  DaxiangMessageService,
  {
    readonly sendLink: (
      input: DaxiangLinkInput,
    ) => Effect.Effect<DaxiangSendResult, DaxiangSendError>;
  }
>()("t3/communication/DaxiangMessageService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const tokenLock = yield* Semaphore.make(1);
  let cached: { clientId: string; secret: string; token: string; expires: number } | undefined;
  const request = <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
  ) =>
    http
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.scoped,
        Effect.timeout("20 seconds"),
      );
  const getToken = Effect.fn("DaxiangMessageService.getToken")(
    function* () {
      const { clientId, clientSecret } = (yield* settings.getSettings).daxiang;
      if (!clientId.trim() || !clientSecret) {
        return yield* new DaxiangSendError({
          message: "Configure DaXiang in Connections > Communication on this environment.",
        });
      }
      const now = yield* Clock.currentTimeMillis;
      if (cached?.clientId === clientId && cached.secret === clientSecret && now < cached.expires)
        return cached.token;
      const jti = yield* crypto.randomUUIDv4();
      const assertion = yield* Effect.tryPromise(() =>
        new SignJWT({})
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(clientId)
          .setIssuer(clientId)
          .setAudience(TOKEN_URL)
          .setJti(jti)
          .setIssuedAt(Math.floor(now / 1000))
          .setExpirationTime(Math.floor(now / 1000) + 3600)
          .sign(new TextEncoder().encode(clientSecret)),
      );
      const response = yield* request(
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "client_credentials",
            scope: "client_id:com.sankuai.it.ead.citadel client_id:xm-xai",
            client_id: clientId,
            client_secret: clientSecret,
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: assertion,
          }),
        ),
        TokenResponse,
      );
      cached = {
        clientId,
        secret: clientSecret,
        token: response.access_token,
        expires: now + Math.max(0, response.expires_in - 300) * 1000,
      };
      return cached.token;
    },
    tokenLock.withPermit,
    Effect.mapError((error) =>
      isDaxiangSendError(error)
        ? error
        : new DaxiangSendError({
            message:
              "Could not authenticate DaXiang. Check this environment's application credentials and permissions.",
          }),
    ),
  );

  const sendLink = Effect.fn("DaxiangMessageService.sendLink")(function* (input: DaxiangLinkInput) {
    const url = yield* Effect.try({
      try: () => new URL(input.url),
      catch: () => new DaxiangSendError({ message: "Invalid message link." }),
    });
    if (url.protocol !== "https:" || url.username || url.password)
      return yield* new DaxiangSendError({
        message: "Message links must use HTTPS without credentials.",
      });
    const recipients = [...new Set(input.recipients)];
    const token = yield* getToken();
    const identities = yield* request(
      HttpClientRequest.post(`${API_URL}/open-apis/dx/queryEmpIdentityByMisList`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe({ misList: recipients }),
      ),
      IdentityResponse,
    ).pipe(
      Effect.mapError(
        () =>
          new DaxiangSendError({
            message: "Could not resolve DaXiang recipients. No message was sent.",
          }),
      ),
    );
    if (identities.status.code !== 0)
      return yield* new DaxiangSendError({
        message: "DaXiang rejected the recipient lookup. No message was sent.",
      });
    const resolved = recipients.flatMap((mis) => {
      const uid = identities.data?.data[mis]?.uid;
      return uid === undefined ? [] : [{ mis, uid }];
    });
    if (resolved.length === 0)
      return { recipients: recipients.map((mis) => ({ mis, status: "failed" as const })) };
    const body = yield* encodeText({
      text: `${input.description}\n${input.title}\n${url.href}`,
    }).pipe(
      Effect.mapError(() => new DaxiangSendError({ message: "Could not encode the message." })),
    );
    // Sending is not retried: a lost response may follow a successful delivery.
    const result = yield* request(
      HttpClientRequest.post(`${API_URL}/open-apis/dx-msg/sendChatMsgByRobot`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe({
          receiverIds: resolved.map(({ uid }) => uid),
          sendMsgInfo: { type: "text", body, isDynamicMsg: false },
        }),
      ),
      SendResponse,
    ).pipe(Effect.option);
    return {
      recipients: recipients.map((mis) => {
        const uid = resolved.find((entry) => entry.mis === mis)?.uid;
        if (uid === undefined) return { mis, status: "failed" as const };
        if (result._tag === "None") return { mis, status: "unknown" as const };
        if (
          result.value.status.code !== 0 ||
          Object.hasOwn(result.value.data?.failMap ?? {}, String(uid))
        )
          return { mis, status: "failed" as const };
        return {
          mis,
          status: Object.hasOwn(result.value.data?.messageMap ?? {}, String(uid))
            ? ("sent" as const)
            : ("unknown" as const),
        };
      }),
    };
  });
  return DaxiangMessageService.of({ sendLink });
});

export const layer = Layer.effect(DaxiangMessageService, make);
