import type { CodexSettings } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { readCustomModelEntries, type CustomModelDefinition } from "@t3tools/shared/model";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const JsonFields = Schema.Record(Schema.String, Schema.Json);
const NativeModel = Schema.StructWithRest(Schema.Struct({ slug: Schema.String }), [JsonFields]);
const Catalog = Schema.StructWithRest(
  Schema.Struct({
    models: Schema.Array(NativeModel),
    t3GeneratedModels: Schema.optionalKey(Schema.Array(Schema.String)),
    t3UsesBundledModels: Schema.optionalKey(Schema.Boolean),
  }),
  [JsonFields],
);
const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(Catalog));
const encodeCatalog = Schema.encodeEffect(fromJsonStringPretty(Catalog));
const nativeTierId = (id: string) => (id === "fast" ? "priority" : id);

class CodexByokCatalogMissingTemplate extends Schema.TaggedError<
  CodexByokCatalogMissingTemplate,
  { readonly brand: unique symbol }
>()("CodexByokCatalogMissingTemplate", {}) {}

function applyCustomModel(base: typeof NativeModel.Type, custom: CustomModelDefinition) {
  const descriptors = custom.capabilities?.optionDescriptors?.filter(
    (option) => option.type === "select",
  );
  const tier = descriptors?.find((option) => option.id === "serviceTier");
  const effort = descriptors?.find((option) => option.id === "reasoningEffort");
  const tiers = new Map(
    tier?.options
      .filter((option) => option.id !== "default")
      .map(
        ({ id, label, description }) =>
          [
            nativeTierId(id),
            { id: nativeTierId(id), name: label, description: description ?? "" },
          ] as const,
      ),
  );
  const defaultTier = tier?.options.find((option) => option.isDefault)?.id;
  return {
    ...base,
    slug: custom.slug,
    display_name: custom.name,
    ...(tier && {
      service_tiers: [...tiers.values()],
      additional_speed_tiers: [],
      default_service_tier:
        defaultTier === undefined || defaultTier === "default" ? null : nativeTierId(defaultTier),
    }),
    ...(effort && {
      supported_reasoning_levels: effort.options.map(({ id, description }) => ({
        effort: id,
        description: description ?? "",
      })),
      default_reasoning_level: effort.options.find((option) => option.isDefault)?.id ?? null,
    }),
  };
}

function fallbackModel(slug: string, instructions: string): typeof NativeModel.Type {
  return {
    slug,
    display_name: slug,
    base_instructions: instructions,
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    supported_reasoning_levels: [],
    supports_reasoning_summaries: true,
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    context_window: 272_000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
  };
}

export const makeCodexByokCatalog = Effect.fn("CodexByokCatalog.make")(function* (
  home: string,
  settings: CodexSettings["customModels"],
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const mutex = yield* Semaphore.make(1);
  const filePath = path.join(home, "context-models.json");
  const customModels = readCustomModelEntries(settings);
  let lastSync: { executable: string; catalogPath: string | undefined } | undefined;

  const sync = Effect.fn("CodexByokCatalog.sync")(function* (executable: string) {
    if (lastSync?.executable === executable) return lastSync.catalogPath;
    const text = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
    if (text === undefined && customModels.length === 0) return undefined;
    const previous: typeof Catalog.Type =
      text === undefined ? { models: [] } : yield* decodeCatalog(text);
    if (customModels.length === 0 && previous.t3GeneratedModels === undefined) return undefined;
    const useBundledModels = text === undefined || previous.t3UsesBundledModels === true;
    const previouslyGenerated = new Set(previous.t3GeneratedModels);
    const models = new Map(
      previous.models
        .filter(({ slug }) => !previouslyGenerated.has(slug))
        .map((model) => [model.slug, model]),
    );
    const generated = new Set(
      customModels.filter(({ slug }) => !models.has(slug)).map(({ slug }) => slug),
    );
    const bundled =
      generated.size === 0 && !useBundledModels
        ? []
        : (yield* spawner
            .string(
              ChildProcess.make(executable || "codex", ["debug", "models", "--bundled"], {
                env: environment,
                extendEnv: false,
              }),
            )
            .pipe(Effect.timeout("5 seconds"), Effect.flatMap(decodeCatalog))).models;
    const bundledBySlug = new Map(bundled.map((model) => [model.slug, model]));
    const fallbackInstructions = bundled.find(
      (model) => model.supported_in_api === true && typeof model.base_instructions === "string",
    )?.base_instructions;
    if (useBundledModels) {
      for (const model of bundled) {
        if (models.has(model.slug)) continue;
        models.set(model.slug, model);
        generated.add(model.slug);
      }
    }
    for (const custom of customModels) {
      const base =
        models.get(custom.slug) ??
        bundledBySlug.get(custom.slug) ??
        (typeof fallbackInstructions === "string"
          ? fallbackModel(custom.slug, fallbackInstructions)
          : undefined);
      if (base === undefined) {
        return yield* new CodexByokCatalogMissingTemplate();
      }
      models.set(custom.slug, applyCustomModel(base, custom));
    }
    const contents = yield* encodeCatalog({
      ...previous,
      models: [...models.values()],
      t3GeneratedModels: [...generated],
      ...(useBundledModels && { t3UsesBundledModels: true }),
    });
    if (text !== contents) {
      yield* writeFileStringAtomically({ filePath, contents });
    }
    lastSync = { executable, catalogPath: filePath };
    return filePath;
  });

  return (executable: string) =>
    mutex
      .withPermits(1)(sync(executable))
      .pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
});
