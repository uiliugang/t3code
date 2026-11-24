import { State, type StateService } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const retiredResources = new Map([
  ["MobileLogsDataset", "Axiom.Dataset"],
  ["MobileMetricsDataset", "Axiom.Dataset"],
  ["MobileSourceMapsBucket", "Cloudflare.R2.Bucket"],
]);

const retainHistoricalData = (store: StateService): StateService => ({
  ...store,
  get(request) {
    const row = store.get(request);
    const type = retiredResources.get(request.fqn);
    if (request.stack !== "T3CodeRelay" || type === undefined) return row;
    return row.pipe(
      Effect.map((resource) =>
        resource && resource.kind !== "action" && resource.resourceType === type
          ? { ...resource, removalPolicy: "retain" as const }
          : resource,
      ),
    );
  },
});

export const legacyTelemetryState = Layer.effect(
  State,
  Effect.map(State, Effect.map(retainHistoricalData)),
);
