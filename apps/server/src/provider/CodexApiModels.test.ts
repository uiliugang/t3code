import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import { codexApiModels } from "./CodexApiModels.ts";

it.effect("discovers the selected API provider's exact model IDs using its instance key", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        urls.push(request.url);
        assert.strictEqual(request.headers.authorization, "Bearer instance-key");
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            data: [{ id: "gpt-6.1-sol" }, { id: "CaseSensitive" }, { id: "gpt-6.1-sol" }],
          }),
        );
      }),
    );
    for (const base of ["http://sub2api.test:8420", "http://sub2api.test:8420/v1/"]) {
      const models = yield* codexApiModels(
        {
          model_provider: "sub2api",
          model_providers: {
            sub2api: {
              base_url: base,
              env_key: "SUB2API_API_KEY",
              requires_openai_auth: false,
              model_catalog_url: null,
              experimental_bearer_token: null,
              http_headers: null,
              env_http_headers: null,
            },
          },
        },
        { SUB2API_API_KEY: "instance-key" },
        "/unused",
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      assert.deepStrictEqual(
        models?.map((model) => model.slug),
        ["gpt-6.1-sol", "CaseSensitive"],
      );
    }
    assert.deepStrictEqual(urls, [
      "http://sub2api.test:8420/v1/models",
      "http://sub2api.test:8420/v1/models",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses API login from the selected home when OpenAI auth is required, ignoring env_key",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-catalog-" });
      yield* fs.writeFileString(
        path.join(home, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "home-api-key" }),
      );
      const models = yield* codexApiModels(
        {
          model_provider: "custom",
          model_providers: {
            custom: {
              base_url: "https://custom.test/v1",
              model_catalog_url: "https://custom.test/catalog",
              requires_openai_auth: true,
              env_key: "IGNORED_KEY",
              http_headers: { "X-Client": "T3" },
              env_http_headers: { "X-Group": "GROUP_ID" },
            },
          },
        },
        { IGNORED_KEY: "wrong-key", GROUP_ID: "group-a" },
        home,
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              assert.strictEqual(request.url, "https://custom.test/catalog");
              assert.strictEqual(request.headers.authorization, "Bearer home-api-key");
              assert.strictEqual(request.headers["x-client"], "T3");
              assert.strictEqual(request.headers["x-group"], "group-a");
              return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
            }),
          ),
        ),
      );
      assert.deepStrictEqual(models, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps empty API catalogs distinct from native discovery and reports failed syncs", () =>
  Effect.gen(function* () {
    const config = {
      model_provider: "custom",
      model_providers: { custom: { base_url: "https://custom.test/v1", env_key: "CUSTOM_KEY" } },
    };
    const environment = { CUSTOM_KEY: "key" };
    for (const body of [{ data: [] }, { data: [{ id: "" }] }, { error: "failed" }]) {
      const result = yield* codexApiModels(config, environment, "/unused").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body))),
          ),
        ),
        Effect.result,
      );
      if ("data" in body && body.data.length === 0) {
        assert.strictEqual(result._tag, "Success");
        if (result._tag === "Success") assert.deepStrictEqual(result.success, []);
      } else {
        assert.strictEqual(result._tag, "Failure");
      }
    }
    const unavailable = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }))),
    );
    const error = yield* Effect.flip(
      codexApiModels(config, environment, "/unused").pipe(
        Effect.provideService(HttpClient.HttpClient, unavailable),
      ),
    );
    assert.strictEqual(error.status, 401);
    assert.notInclude(error.message, "key");
    const missing = yield* Effect.flip(
      codexApiModels(config, {}, "/unused").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Must not send without a configured key")),
        ),
      ),
    );
    assert.strictEqual(missing.reason, "credentials");
    assert.isUndefined(
      yield* codexApiModels(
        { model_provider: null, model_providers: {}, openai_base_url: null },
        {},
        "/unused",
      ).pipe(Effect.provideService(HttpClient.HttpClient, unavailable)),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
