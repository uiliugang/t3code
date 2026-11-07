import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as WechatClient from "./WechatClient.ts";

describe("WechatClient", () => {
  it("accepts only Tencent HTTPS API hosts", () => {
    assert.equal(
      WechatClient.wechatApiBase("https://ilinkai.weixin.qq.com"),
      "https://ilinkai.weixin.qq.com",
    );
    for (const base of [
      "http://ilinkai.weixin.qq.com",
      "https://ilinkai.weixin.qq.com.evil.test",
      "https://user@ilinkai.weixin.qq.com",
      "https://ilinkai.weixin.qq.com/path",
      "https://ilinkai.weixin.qq.com:8443",
    ])
      assert.throws(() => WechatClient.wechatApiBase(base));
  });
  it.effect(
    "uses QR POST, handles verification, preserves context and checks business errors",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ method: string; url: string; body: unknown }> = [];
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            requests.push({ method: request.method, url: request.url, body });
            const payload = request.url.includes("get_bot_qrcode")
              ? { qrcode: "qr", qrcode_img_content: "https://liteapp.weixin.qq.com/qr" }
              : request.url.includes("get_qrcode_status")
                ? { status: "need_verifycode" }
                : request.url.includes("getupdates")
                  ? {
                      ret: 0,
                      msgs: [
                        {
                          message_id: 9,
                          from_user_id: "user",
                          message_type: 1,
                          create_time_ms: 1,
                          context_token: "context",
                          item_list: [{ type: 1, text_item: { text: "你好" } }],
                        },
                      ],
                      get_updates_buf: "next",
                    }
                  : { ret: -14 };
            return HttpClientResponse.fromWeb(request, Response.json(payload));
          }),
        );
        yield* Effect.gen(function* () {
          const client = yield* WechatClient.WechatClient;
          assert.equal((yield* client.begin).qrcode, "qr");
          assert.equal(
            (yield* client.login({
              baseUrl: "https://ilinkai.weixin.qq.com",
              qrcode: "qr",
              code: "123",
            })).status,
            "need_verifycode",
          );
          const updates = yield* client.updates(
            { baseUrl: "https://ilinkai.weixin.qq.com", token: "secret" },
            "before",
          );
          assert.equal(updates.messages[0]?.context_token, "context");
          assert.equal(updates.cursor, "next");
          const error = yield* client
            .send(
              { baseUrl: "https://ilinkai.weixin.qq.com", token: "secret" },
              { userId: "user", contextToken: "context", clientId: "stable-id", text: "a\nb" },
            )
            .pipe(Effect.flip);
          assert.equal(error.reason, "credentials");
          assert.equal(requests[0]?.method, "POST");
          assert.include(String(requests[0]?.body), '"local_token_list":[]');
          assert.include(requests[1]!.url, "verify_code=123");
          assert.include(String(requests[3]?.body), '"context_token":"context"');
          assert.include(String(requests[3]?.body), "a\\r\\nb");
          assert.equal(requests.length, 4);
        }).pipe(
          Effect.provide(WechatClient.layer.pipe(Layer.provide(NodeCrypto.layer))),
          Effect.provideService(HttpClient.HttpClient, http),
        );
      }),
  );
  it.effect.each([
    {
      name: "message ID without return codes",
      status: 200,
      payload: { message_id: "123" },
      reason: null,
    },
    { name: "omitted default return codes", status: 200, payload: {}, reason: null },
    { name: "explicit success", status: 200, payload: { ret: 0 }, reason: null },
    { name: "errcode success", status: 200, payload: { errcode: 0 }, reason: null },
    { name: "malformed ret", status: 200, payload: { ret: "-1" }, reason: "protocol" },
    { name: "malformed errcode", status: 200, payload: { errcode: "-14" }, reason: "protocol" },
    { name: "ret failure", status: 200, payload: { ret: -1, errcode: 0 }, reason: "protocol" },
    { name: "errcode failure", status: 200, payload: { ret: 0, errcode: -1 }, reason: "protocol" },
    {
      name: "expired credentials",
      status: 200,
      payload: { ret: 0, errcode: -14 },
      reason: "credentials",
    },
    { name: "HTTP failure", status: 503, payload: {}, reason: "network" },
  ])("handles $name when sending without retrying", ({ status, payload, reason }) => {
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts++;
        return HttpClientResponse.fromWeb(request, Response.json(payload, { status }));
      }),
    );
    return Effect.gen(function* () {
      const client = yield* WechatClient.WechatClient;
      const result = yield* client
        .send(
          { baseUrl: "https://ilinkai.weixin.qq.com", token: "secret" },
          { userId: "user", clientId: "stable", text: "result" },
        )
        .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error.reason }));
      assert.equal(result, reason);
      assert.equal(attempts, 1);
    }).pipe(
      Effect.provide(WechatClient.layer.pipe(Layer.provide(NodeCrypto.layer))),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  });
});
