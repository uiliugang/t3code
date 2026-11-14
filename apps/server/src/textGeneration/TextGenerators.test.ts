import { it } from "@effect/vitest";
import {
  type ManagedPolicySummary,
  ProviderDriverKind,
  ProviderInstanceId,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { TestClock } from "effect/testing";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as TextGenerators from "./TextGenerators.ts";

const ID = ProviderInstanceId.make("router");

const layer = (generator: Partial<TextGeneratorConfig>, policy?: ManagedPolicySummary) =>
  Layer.effect(TextGenerators.TextGenerators, TextGenerators.make).pipe(
    Layer.provideMerge(
      ServerSettings.layerTest(
        {
          textGenerators: {
            [ID]: { kind: "openaiCompatible", baseUrl: "https://api.test/v1", ...generator },
          },
        },
        policy,
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
  );

const request = {
  operation: "generateThreadTitle",
  cwd: "/unused",
  prompt: "Name this thread.",
  outputSchema: Schema.Struct({ title: Schema.String }),
  modelSelection: { instanceId: ID, model: "some/model" },
} as const;

it.effect("uses a configured model without discovery or an API key", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/v1/chat/completions");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body)).model).toBe("deepseek-v4.1-flash");
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
    });
    const generators = yield* TextGenerators.TextGenerators;
    const settings = yield* ServerSettings.ServerSettingsService;
    const listed = yield* generators
      .listModels({ id: ID })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(listed.models).toEqual([{ id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" }]);
    expect(upstream).not.toHaveBeenCalled();
    const tested = yield* generators
      .listModels({ id: ID, test: true })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(tested.testedModel).toBe("deepseek-v4.1-flash");
    expect(upstream).toHaveBeenCalledTimes(1);

    const config = {
      kind: "openaiCompatible",
      baseUrl: "https://api.test/v1",
      apiKey: "",
      enabled: true,
    } as const;
    yield* settings.updateSettings({
      textGenerators: { [ID]: { ...config, model: "replacement-model" } },
    });
    const changed = yield* generators
      .listModels({ id: ID })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(changed.models).toEqual([{ id: "replacement-model", name: "replacement-model" }]);
    expect(upstream).toHaveBeenCalledTimes(1);

    yield* settings.updateSettings({ textGenerators: { [ID]: config } });
    upstream.mockImplementation(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/v1/models");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ data: [{ id: "discovered-model" }] });
    });
    const discovered = yield* generators
      .listModels({ id: ID })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(discovered.models).toEqual([{ id: "discovered-model", name: "discovered-model" }]);
    expect(upstream).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer({ model: "deepseek-v4.1-flash" }))),
);

it.effect.each([
  {
    kind: "openaiCompatible",
    path: "/v1/chat/completions",
    auth: ["authorization", "Bearer secret"],
    reply: { choices: [{ finish_reason: "stop", message: { content: '{"title":"Fix login"}' } }] },
  },
  {
    kind: "anthropic",
    path: "/v1/messages",
    auth: ["x-api-key", "secret"],
    reply: { stop_reason: "end_turn", content: [{ type: "text", text: '{"title":"Fix login"}' }] },
  },
] as const)("$kind generates structured text with its API's request shape", (api) =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(api.path);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get(api.auth[0])).toBe(api.auth[1]);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("some/model");
      expect(body.messages).toEqual([{ role: "user", content: "Name this thread." }]);
      return Response.json(api.reply);
    });
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(layer({ kind: api.kind, apiKey: "secret" })),
    );
    const run = yield* generators.runner(ID);
    expect(run).toBeDefined();
    const result = yield* run!(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, upstream),
    );
    expect(result).toEqual({ title: "Fix login" });
    expect(yield* generators.runner(ProviderInstanceId.make("codex"))).toBeUndefined();

    upstream.mockResolvedValueOnce(
      Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }),
    );
    const failure = yield* Effect.flip(
      run!(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.detail).toMatch(/rejected the API key: Incorrect API key provided$/);
    expect(upstream).toHaveBeenCalledTimes(2);
  }),
);

it.effect.each([
  { scenario: "a small gateway default", truncatedReplies: 0, succeeds: true },
  { scenario: "reasoning exhausting the first budget", truncatedReplies: 1, succeeds: true },
  { scenario: "both output budgets exhausted", truncatedReplies: 2, succeeds: false },
])("generates PR content with $scenario", ({ truncatedReplies, succeeds }) =>
  Effect.gen(function* () {
    const budgets: number[] = [];
    const expected = { title: "Fix update settings", body: "## Summary\nWrap long update errors." };
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      budgets.push(body.max_tokens);
      const truncated = !body.max_tokens || budgets.length <= truncatedReplies;
      return Response.json({
        choices: [
          {
            finish_reason: truncated ? "length" : "stop",
            message: { content: truncated ? null : JSON.stringify(expected) },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 8192 },
      });
    });
    const generators = yield* TextGenerators.TextGenerators.pipe(Effect.provide(layer({})));
    const run = yield* generators.runner(ID);
    const result = yield* run!({
      ...request,
      operation: "generatePrContent",
      outputSchema: Schema.Struct({ title: Schema.String, body: Schema.String }),
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.result);
    if (succeeds) {
      expect(result).toEqual(Result.succeed(expected));
    } else {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.detail).toContain("output limit");
    }
    expect(budgets).toEqual(truncatedReplies === 0 ? [8192] : [8192, 16384]);
  }),
);

it.effect("keeps the output retry within the original generation deadline", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const firstReply = Promise.withResolvers<Response>();
    const secondReply = Promise.withResolvers<Response>();
    const upstream = vi.fn<typeof fetch>(() => {
      if (upstream.mock.calls.length === 1) {
        Deferred.doneUnsafe(firstStarted, Effect.void);
        return firstReply.promise;
      }
      Deferred.doneUnsafe(secondStarted, Effect.void);
      return secondReply.promise;
    });
    const generators = yield* TextGenerators.TextGenerators.pipe(Effect.provide(layer({})));
    const run = yield* generators.runner(ID);
    const generation = yield* run!(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, upstream),
      Effect.result,
      Effect.forkChild,
    );
    yield* Deferred.await(firstStarted);
    yield* TestClock.adjust("1 minute");
    firstReply.resolve(
      Response.json({ choices: [{ finish_reason: "length", message: { content: null } }] }),
    );
    yield* Effect.raceFirst(Deferred.await(secondStarted), Fiber.await(generation));
    expect(upstream).toHaveBeenCalledTimes(2);
    yield* TestClock.adjust("1 minute");
    const result = yield* Fiber.join(generation);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.detail).toContain("took too long");
    secondReply.resolve(Response.json({}));
  }),
);

it.effect("uses the supported output budget parameter for reasoning APIs", () =>
  Effect.gen(function* () {
    const budgets: Array<{ max_tokens?: number; max_completion_tokens?: number }> = [];
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      budgets.push({
        ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
        ...(body.max_completion_tokens === undefined
          ? {}
          : { max_completion_tokens: body.max_completion_tokens }),
      });
      if (body.max_tokens !== undefined) {
        return Response.json(
          {
            error: {
              message: "Use max_completion_tokens instead.",
              code: "unsupported_parameter",
              param: "max_tokens",
            },
          },
          { status: 400 },
        );
      }
      return Response.json({
        choices: [
          {
            finish_reason: budgets.length < 3 ? "length" : "stop",
            message: { content: '{"title":"Fix update settings"}' },
          },
        ],
      });
    });
    const generators = yield* TextGenerators.TextGenerators.pipe(Effect.provide(layer({})));
    const run = yield* generators.runner(ID);
    const result = yield* run!(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, upstream),
    );
    expect(result).toEqual({ title: "Fix update settings" });
    expect(budgets).toEqual([
      { max_tokens: 8192 },
      { max_completion_tokens: 8192 },
      { max_completion_tokens: 16384 },
    ]);
  }),
);

it.effect("a turned-off text generator fails instead of calling its API", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>();
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(layer({ enabled: false, label: "OpenRouter" })),
    );
    const run = yield* generators.runner(ID);
    const failure = yield* Effect.flip(
      run!(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.detail).toBe("OpenRouter is off. Turn it on in Settings → Providers.");
    expect(upstream).not.toHaveBeenCalled();
  }),
);

it.effect("lists models once per config, following Anthropic pagination, until refreshed", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/v1/models");
      return parsed.searchParams.get("after_id") === "claude-b"
        ? Response.json({ data: [{ id: "claude-a" }], has_more: false })
        : Response.json({
            data: [{ id: "claude-b", display_name: "Claude B" }],
            has_more: true,
            last_id: "claude-b",
          });
    });
    const program = Effect.gen(function* () {
      const generators = yield* TextGenerators.TextGenerators;
      const settings = yield* ServerSettings.ServerSettingsService;
      const list = (refresh?: boolean) =>
        generators
          .listModels({ id: ID, ...(refresh ? { refresh } : {}) })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));

      expect((yield* list()).models).toEqual([
        { id: "claude-a", name: "claude-a" },
        { id: "claude-b", name: "Claude B" },
      ]);
      yield* list();
      expect(upstream).toHaveBeenCalledTimes(2);

      yield* list(true);
      expect(upstream).toHaveBeenCalledTimes(4);

      yield* settings.updateSettings({
        textGenerators: {
          [ID]: {
            kind: "anthropic",
            baseUrl: "https://api.test/v1",
            apiKey: "rotated",
            enabled: true,
          },
        },
      });
      yield* list();
      expect(upstream).toHaveBeenCalledTimes(6);
    });
    yield* program.pipe(Effect.provide(layer({ kind: "anthropic", apiKey: "secret" })));
  }),
);

it.effect("checks unsaved settings, keeping the saved key behind a redaction marker", () =>
  Effect.gen(function* () {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return String(url).endsWith("/chat/completions")
        ? Response.json({
            model: JSON.parse(String(init?.body)).model,
            choices: [{ finish_reason: "stop", message: { content: "OK" } }],
          })
        : Response.json({ data: [{ id: "model-a" }] });
    });
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(layer({ apiKey: "saved-key" })),
    );
    const list = (id: string, config: Partial<TextGeneratorConfig>) =>
      generators
        .listModels({
          id: ProviderInstanceId.make(id),
          config: {
            kind: "openaiCompatible",
            baseUrl: "https://new.test/v1",
            apiKey: "",
            enabled: true,
            ...config,
          },
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));

    expect((yield* list("draft", { apiKey: "typed-key" })).models).toEqual([
      { id: "model-a", name: "model-a" },
    ]);
    yield* list(ID, { apiKey: SECRET_REDACTED });
    expect(seen).toEqual([
      { url: "https://new.test/v1/models", auth: "Bearer typed-key" },
      { url: "https://new.test/v1/models", auth: "Bearer saved-key" },
    ]);

    // Listing alone proves nothing about the key on some APIs; a test asks the model itself.
    const tested = yield* generators
      .listModels({ id: ID, test: true, model: "chosen/model" })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(tested.testedModel).toBe("chosen/model");
    expect(seen.at(-1)).toEqual({
      url: "https://api.test/v1/chat/completions",
      auth: "Bearer saved-key",
    });

    // An allow-list names agent drivers only, so no unsaved config may reach an API either.
    const managed = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(
        layer(
          { apiKey: "saved-key" },
          {
            organization: "Example Corp",
            lockedSettings: [],
            limits: {
              providers: {
                allowedDrivers: [ProviderDriverKind.make("codex")],
                lockedInstanceFields: {},
              },
            },
          },
        ),
      ),
    );
    const requestsBefore = seen.length;
    const refused = yield* managed
      .listModels({
        id: ProviderInstanceId.make("draft"),
        config: {
          kind: "openaiCompatible",
          baseUrl: "https://new.test/v1",
          apiKey: "k",
          enabled: true,
        },
        test: true,
      })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.flip);
    expect(refused.detail).toContain("policy");
    expect(seen).toHaveLength(requestsBefore);
  }),
);
