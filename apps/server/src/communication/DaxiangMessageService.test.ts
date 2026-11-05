import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Settings from "../serverSettings.ts";
import * as Daxiang from "./DaxiangMessageService.ts";

const input = {
  recipients: ["alice", "bob", "missing"],
  title: "PR #1111",
  description: "Review",
  url: "https://dev.sankuai.com/code/pr/1111",
};

it.layer(NodeCrypto.layer)("DaXiang messages", (it) => {
  it.effect("resolves MIS, reports partial delivery, and caches application tokens", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const bodies: unknown[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path.endsWith("/token"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "test-token", expires_in: 3600 }),
            );
          assert.equal(request.headers.authorization, "Bearer test-token");
          if (path.endsWith("queryEmpIdentityByMisList"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                status: { code: 0 },
                data: { data: { alice: { uid: 1 }, bob: { uid: 2 } } },
              }),
            );
          if (request.body._tag === "Uint8Array")
            bodies.push(JSON.parse(new TextDecoder().decode(request.body.body)));
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              status: { code: 0 },
              data: { messageMap: { "1": "message-id" }, failMap: { "2": "denied" } },
            }),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* Daxiang.DaxiangMessageService;
        for (let i = 0; i < 2; i++) {
          assert.deepEqual(yield* service.sendLink(input), {
            recipients: [
              { mis: "alice", status: "sent" },
              { mis: "bob", status: "failed" },
              { mis: "missing", status: "failed" },
            ],
          });
        }
      }).pipe(
        Effect.provide(Daxiang.layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(
          Settings.ServerSettingsService.layerTest({
            daxiang: { clientId: "test-app", clientSecret: "test-secret" },
          }),
        ),
      );
      assert.equal(paths.filter((path) => path.endsWith("/token")).length, 1);
      assert.deepEqual(bodies[0], {
        receiverIds: [1, 2],
        sendMsgInfo: {
          type: "text",
          body: JSON.stringify({ text: "Review\nPR #1111\nhttps://dev.sankuai.com/code/pr/1111" }),
          isDynamicMsg: false,
        },
      });
    }),
  );

  it.effect("does not retry an ambiguous send response", () =>
    Effect.gen(function* () {
      let sends = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/token"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "test-token", expires_in: 3600 }),
            );
          if (path.endsWith("queryEmpIdentityByMisList"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ status: { code: 0 }, data: { data: { alice: { uid: 1 } } } }),
            );
          sends++;
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
        }),
      );
      const result = yield* Daxiang.DaxiangMessageService.pipe(
        Effect.flatMap((service) => service.sendLink({ ...input, recipients: ["alice"] })),
        Effect.provide(Daxiang.layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(
          Settings.ServerSettingsService.layerTest({
            daxiang: { clientId: "app", clientSecret: "secret" },
          }),
        ),
      );
      assert.deepEqual(result, { recipients: [{ mis: "alice", status: "unknown" }] });
      assert.equal(sends, 1);
    }),
  );

  it.effect("rejects missing credentials without contacting DaXiang", () =>
    Effect.gen(function* () {
      let requests = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests++;
          return HttpClientResponse.fromWeb(request, Response.json({}));
        }),
      );
      const result = yield* Daxiang.DaxiangMessageService.pipe(
        Effect.flatMap((service) => service.sendLink(input)),
        Effect.flip,
        Effect.provide(Daxiang.layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(Settings.ServerSettingsService.layerTest()),
      );
      assert.equal(result._tag, "DaxiangSendError");
      assert.equal(
        result.message,
        "Configure DaXiang in Connections > Communication on this environment.",
      );
      assert.equal(requests, 0);
    }),
  );
});
