import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformEffect({
      decode: (raw) => {
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined && raw.options !== null) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          instanceId: value.instanceId,
          model: value.model,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export type SettingsModelSelection = ModelSelection & { readonly virtualModelId?: string };
const VirtualReference = Schema.Struct({ virtualModelId: TrimmedNonEmptyString });
const ReferenceSelection = VirtualReference.pipe(
  Schema.decodeTo(
    Schema.Struct({ ...ModelSelectionWire.fields, ...VirtualReference.fields }),
    SchemaTransformation.transform({
      decode: ({ virtualModelId }) => ({
        virtualModelId,
        instanceId: "t3-virtual",
        model: virtualModelId,
      }),
      encode: ({ virtualModelId }) => ({ virtualModelId }),
    }),
  ),
);
export const SettingsModelSelection: Schema.Codec<
  SettingsModelSelection,
  typeof VirtualReference.Encoded | typeof ModelSelection.Encoded
> = Schema.Union([ReferenceSelection, ModelSelection]);
