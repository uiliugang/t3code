import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});
const decodeProbeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.optionalKey(Schema.Number), method: Schema.String }),
  ),
);

it.effect.each(["native", "api", "api-empty", "api-error", "api-timeout"] as const)(
  "reads idle account usage alongside %s model discovery",
  (catalogSource) =>
    Effect.gen(function* () {
      const custom = catalogSource !== "native";
      const failed = catalogSource === "api-error" || catalogSource === "api-timeout";
      const capabilities = {
        optionDescriptors: [{ id: "fastMode", label: "Fast mode", type: "boolean" as const }],
      };
      const output = yield* Effect.acquireRelease(Queue.unbounded<Uint8Array>(), Queue.shutdown);
      const usageRequest = yield* Deferred.make<number>();
      const apiRequest = yield* Deferred.make<void>();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const { id, method } = decodeProbeRequest(decoder.decode(chunk));
          if (id === undefined) return Effect.void;
          if (method === "account/rateLimits/read") {
            return Deferred.succeed(usageRequest, id);
          }
          const responses: Record<string, unknown> = {
            initialize: {
              userAgent: "codex/1.0.0",
              codexHome: "/codex-home",
              platformFamily: "unix",
              platformOs: "darwin",
            },
            "account/read": { account: null, requiresOpenaiAuth: false },
            "model/list": {
              data: ["native-only", "CaseSensitive"].map((slug) => ({
                id: slug,
                model: slug,
                displayName: slug,
                hidden: false,
                isDefault: slug === "native-only",
                description: "Native",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
              })),
              nextCursor: null,
            },
            "config/read": {
              config: custom
                ? {
                    model_provider: "sub2api",
                    model_providers: {
                      sub2api: {
                        base_url: "https://sub2api.test/v1",
                        env_key: "SUB2API_API_KEY",
                        model_catalog_url: null,
                        http_headers: null,
                        env_http_headers: null,
                        experimental_bearer_token: null,
                      },
                    },
                  }
                : {},
              origins: {},
            },
            "skills/list": { data: [] },
          };
          const frame =
            method in responses
              ? { id, result: responses[method] }
              : { id, error: { code: -32601, message: "Unsupported request" } };
          return Queue.offer(output, encoder.encode(`${JSON.stringify(frame)}\n`));
        }),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      const probe = yield* checkCodexProviderStatus(
        {
          ...defaultCodexSettings,
          customModels: custom ? [{ slug: "gpt-6.1-sol", name: "My Sol", capabilities }] : [],
        },
        undefined,
        { SUB2API_API_KEY: "instance-key" },
        undefined,
        [{ slug: "last-synced", name: "Last synced", isCustom: false, capabilities: null }],
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                catalogSource === "api-timeout"
                  ? Deferred.succeed(apiRequest, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.sync(() => {
                      assert.isTrue(custom);
                      assert.strictEqual(request.url, "https://sub2api.test/v1/models");
                      assert.strictEqual(request.headers.authorization, "Bearer instance-key");
                      return HttpClientResponse.fromWeb(
                        request,
                        catalogSource === "api-error"
                          ? new Response(null, { status: 401 })
                          : Response.json({
                              data:
                                catalogSource === "api-empty"
                                  ? []
                                  : [{ id: "gpt-6.1-sol" }, { id: "CaseSensitive" }],
                            }),
                      );
                    }),
              ),
            ),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.succeed(handle)),
            ),
          ),
        ),
        Effect.forkChild,
      );
      const id = yield* Deferred.await(usageRequest);
      if (catalogSource === "api-timeout") {
        yield* Deferred.await(apiRequest);
        yield* TestClock.adjust("10 seconds");
      } else if (catalogSource === "native") {
        yield* TestClock.adjust("5 seconds");
      }
      yield* Queue.offer(
        output,
        encoder.encode(
          `${JSON.stringify({
            id,
            result: {
              rateLimits: {
                primary: { usedPercent: 46, windowDurationMins: 10_080, resetsAt: null },
                secondary: null,
              },
            },
          })}\n`,
        ),
      );
      const status = yield* Fiber.join(probe);
      assert.strictEqual(status.status, failed ? "warning" : "ready");
      assert.deepStrictEqual(
        status.models.map((model) => model.slug),
        catalogSource === "native"
          ? ["native-only", "CaseSensitive"]
          : failed
            ? ["last-synced", "gpt-6.1-sol"]
            : catalogSource === "api-empty"
              ? ["gpt-6.1-sol"]
              : ["gpt-6.1-sol", "CaseSensitive"],
      );
      if (custom) {
        const manual = status.models.find((model) => model.slug === "gpt-6.1-sol");
        assert.strictEqual(manual?.name, "My Sol");
        assert.strictEqual(manual?.isCustom, true);
        assert.deepStrictEqual(manual?.capabilities, capabilities);
      }
      if (catalogSource === "api-error") assert.include(status.message, "HTTP 401");
      if (catalogSource === "api-timeout") assert.include(status.message, "Could not reach");
      if (catalogSource === "api") {
        assert.isTrue(
          status.models
            .find((model) => model.slug === "CaseSensitive")
            ?.capabilities?.optionDescriptors?.some(
              (descriptor) => descriptor.id === "reasoningEffort",
            ),
        );
      }
      assert.deepStrictEqual(status.usageLimits?.windows, [
        {
          id: "primary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 46,
          windowDurationMins: 10_080,
        },
      ]);
      assert.strictEqual(status.usageLimits?.unavailable, undefined);
    }).pipe(Effect.scoped),
);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
