import type { DeliveryScope, DeliveryEvidence } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

const Plan = Schema.Struct({
  id: Schema.Number,
  status: Schema.Number,
  steps: Schema.Array(
    Schema.Struct({
      status: Schema.Number,
      stepOperation: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            items: Schema.Array(
              Schema.Struct({
                appKey: Schema.String,
                env: Schema.String,
                status: Schema.String,
                prList: Schema.optional(Schema.Array(Schema.Struct({ link: Schema.String }))),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
});

const decodePlan = Schema.decodeUnknownSync(Plan);
const decodePlanJson = Schema.decodeEffect(Schema.fromJsonString(Plan));

export function readMcmCoverage(
  input: unknown,
  services: DeliveryScope["changedServices"],
): DeliveryEvidence["releases"] {
  const plan = decodePlan(input);
  if (plan.status !== 8) return [];
  return services.flatMap((service) =>
    plan.steps.some(
      (step) =>
        step.status === 3 &&
        step.stepOperation?.items.some(
          (operation) =>
            operation.appKey === service.appkey &&
            operation.env === service.target &&
            operation.status === "SUCCEED" &&
            operation.prList?.some((pr) => pr.link === service.revision),
        ),
    )
      ? [{ ...service, planId: String(plan.id), completed: true }]
      : [],
  );
}

export class McmReleaseError extends Schema.TaggedError<
  McmReleaseError,
  { readonly brand: unique symbol }
>()("McmReleaseError", {
  cause: Schema.Defect(),
}) {}
const isMcmReleaseError = Schema.is(McmReleaseError);

export class McmReleaseService extends Context.Service<
  McmReleaseService,
  {
    readonly read: (
      planId: string,
      services: DeliveryScope["changedServices"],
    ) => Effect.Effect<DeliveryEvidence["releases"], McmReleaseError>;
  }
>()("t3/work-items/McmReleaseService") {}

export const layer = Layer.effect(
  McmReleaseService,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const read = Effect.fn("McmReleaseService.read")(
      function* (planId: string, services: DeliveryScope["changedServices"]) {
        if (!/^[1-9]\d*$/.test(planId))
          return yield* new McmReleaseError({ cause: new Error("Invalid MCM plan identifier") });
        const result = yield* runner.run({
          command: "mcm",
          args: ["plan", "detail", planId, "--format", "json"],
          timeout: "30 seconds",
        });
        if (result.code !== 0 || result.timedOut || result.stdoutTruncated)
          return yield* new McmReleaseError({ cause: new Error("Could not read MCM plan") });
        const plan = yield* decodePlanJson(result.stdout);
        return readMcmCoverage(plan, services);
      },
      Effect.mapError((cause) =>
        isMcmReleaseError(cause) ? cause : new McmReleaseError({ cause }),
      ),
    );
    return { read };
  }),
);
