import * as Axiom from "@alchemy.run/axiom";
import * as R2 from "@alchemy.run/cloudflare/R2";
import { expect, it } from "@effect/vitest";
import { apply } from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { inMemoryState, type ResourceState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { legacyTelemetryState } from "./legacyTelemetryState.ts";

it.effect(
  "retires mobile telemetry without deleting historical data or retaining credentials",
  () =>
    Effect.gen(function* () {
      const legacyRow = (fqn: string, resourceType: string): ResourceState => ({
        fqn,
        logicalId: fqn,
        resourceType,
        namespace: undefined,
        instanceId: fqn,
        providerVersion: 0,
        status: "created",
        removalPolicy: "destroy",
        props: {},
        attr: {},
        downstream: [],
        bindings: [],
      });
      const rows = [
        legacyRow("MobileLogsDataset", "Axiom.Dataset"),
        legacyRow("MobileMetricsDataset", "Axiom.Dataset"),
        legacyRow("MobileSourceMapsBucket", "Cloudflare.R2.Bucket"),
        legacyRow("MobileTelemetryAxiomIngestToken", "Axiom.ApiToken"),
      ];
      const state = inMemoryState({
        T3CodeRelay: { prod: Object.fromEntries(rows.map((row) => [row.fqn, row])) },
      });
      const deleted: string[] = [];
      const provider = {
        reconcile: () => Effect.die("unexpected create or update"),
        delete: ({ fqn }: { fqn: string }) =>
          Effect.sync(() => {
            deleted.push(fqn);
          }),
      };
      const stack = {
        name: "T3CodeRelay",
        stage: "prod",
        resources: {},
        bindings: {},
        actions: {},
        output: undefined,
      };
      const services = Layer.mergeAll(
        legacyTelemetryState.pipe(Layer.provide(state)),
        Provider.succeed(Axiom.Dataset, provider),
        Provider.succeed(R2.Bucket, provider),
        Provider.succeed(Axiom.ApiToken, provider),
        Layer.succeed(Stack, stack),
        Layer.succeed(Stage, stack.stage),
      );
      const planUpgrade = Plan.make(stack).pipe(Effect.provide(services));
      const plan = yield* planUpgrade;
      expect(
        Object.fromEntries(
          Object.entries(plan.deletions).map(([fqn, node]) => [fqn, node?.action]),
        ),
      ).toEqual({
        MobileLogsDataset: "orphaned",
        MobileMetricsDataset: "orphaned",
        MobileSourceMapsBucket: "orphaned",
        MobileTelemetryAxiomIngestToken: "delete",
      });
      yield* apply(plan).pipe(Effect.provide(services));
      expect(deleted).toEqual(["MobileTelemetryAxiomIngestToken"]);
      const subsequent = yield* planUpgrade;
      expect(subsequent.deletions).toEqual({});
      expect(subsequent.resources).toEqual({});
    }),
);
