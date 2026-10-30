import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

class CodexApiCatalogError extends Schema.TaggedError<CodexApiCatalogError>()(
  "CodexApiCatalogError",
  {
    reason: Schema.Literals(["config", "credentials", "request", "response"]),
    status: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "config":
        return "Check the custom Codex provider's base URL and model catalog configuration.";
      case "credentials":
        return "The custom model catalog credentials are unavailable. Check this instance's variables or API key login.";
      case "request":
        return "Could not reach the custom provider's model catalog.";
      case "response":
        return this.status === undefined
          ? "The custom provider returned an invalid model catalog. Expected data[].id."
          : `The custom model catalog returned HTTP ${this.status}.`;
    }
  }
}

const ApiProvider = Schema.Struct({
  base_url: Schema.NonEmptyString,
  model_catalog_url: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  env_key: Schema.optional(Schema.NullOr(Schema.String)),
  requires_openai_auth: Schema.optional(Schema.Boolean),
  experimental_bearer_token: Schema.optional(Schema.NullOr(Schema.String)),
  http_headers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  env_http_headers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
});
const Catalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
});
const decodeApiProvider = Schema.decodeUnknownEffect(ApiProvider);
const decodeCatalog = Schema.decodeUnknownEffect(Catalog);
const decodeApiAuth = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ OPENAI_API_KEY: Schema.NonEmptyString })),
);

export const codexApiModels = Effect.fn("CodexApiModels.discover")(
  function* (
    config: Readonly<Record<string, unknown>>,
    environment: NodeJS.ProcessEnv,
    codexHome: string,
  ) {
    const providerId = typeof config.model_provider === "string" ? config.model_provider : "openai";
    const providers = config.model_providers;
    const openaiBaseUrl =
      environment.OPENAI_BASE_URL ||
      (typeof config.openai_base_url === "string" ? config.openai_base_url : undefined);
    const configured =
      providers !== null && typeof providers === "object" && !Array.isArray(providers)
        ? (Object.getOwnPropertyDescriptor(providers, providerId)?.value as unknown)
        : undefined;
    if (providerId === "openai" && configured === undefined && !openaiBaseUrl) {
      return undefined;
    }
    const provider = yield* decodeApiProvider(
      configured ??
        (providerId === "openai"
          ? {
              base_url: openaiBaseUrl,
              ...(environment.OPENAI_API_KEY
                ? { env_key: "OPENAI_API_KEY" }
                : { requires_openai_auth: true }),
            }
          : undefined),
    ).pipe(Effect.mapError((cause) => new CodexApiCatalogError({ reason: "config", cause })));
    const url = yield* Effect.try({
      try: () => {
        const base = new URL(provider.base_url);
        const path = base.pathname.replace(/\/+$/, "");
        base.pathname = `${path}${path.endsWith("/v1") ? "" : "/v1"}/models`;
        const catalog = provider.model_catalog_url ? new URL(provider.model_catalog_url) : base;
        if (
          !["http:", "https:"].includes(catalog.protocol) ||
          catalog.username ||
          catalog.password
        ) {
          throw new Error("Invalid catalog URL");
        }
        return catalog.toString();
      },
      catch: (cause) => new CodexApiCatalogError({ reason: "config", cause }),
    });
    const headers = { ...provider.http_headers };
    for (const [name, variable] of Object.entries(provider.env_http_headers ?? {})) {
      const value = environment[variable];
      if (!value) return yield* new CodexApiCatalogError({ reason: "credentials" });
      headers[name] = value;
    }
    let token = provider.experimental_bearer_token;
    if (provider.requires_openai_auth) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const auth = yield* fs.readFileString(path.join(codexHome, "auth.json")).pipe(
        Effect.flatMap(decodeApiAuth),
        Effect.mapError((cause) => new CodexApiCatalogError({ reason: "credentials", cause })),
      );
      token = auth.OPENAI_API_KEY;
    } else if (provider.env_key) {
      token = environment[provider.env_key];
      if (!token) return yield* new CodexApiCatalogError({ reason: "credentials" });
    }
    const http = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers));
    const response = yield* http
      .execute(token ? HttpClientRequest.bearerToken(request, token) : request)
      .pipe(Effect.mapError((cause) => new CodexApiCatalogError({ reason: "request", cause })));
    if (response.status !== 200) {
      return yield* new CodexApiCatalogError({ reason: "response", status: response.status });
    }
    const catalog = yield* response.json.pipe(
      Effect.flatMap(decodeCatalog),
      Effect.mapError((cause) => new CodexApiCatalogError({ reason: "response", cause })),
    );
    return [...new Set(catalog.data.map((model) => model.id))].map(
      (slug) =>
        ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
          ...(config.model === slug ? { isDefault: true } : {}),
        }) satisfies ServerProviderModel,
    );
  },
  Effect.timeoutOrElse({
    duration: "10 seconds",
    orElse: () => Effect.fail(new CodexApiCatalogError({ reason: "request" })),
  }),
);
