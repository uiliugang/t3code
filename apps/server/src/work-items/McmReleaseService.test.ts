import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import { ProcessRunner } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { layer, McmReleaseError, McmReleaseService, readMcmCoverage } from "./McmReleaseService.ts";

it.effect("reports the exit code and the first nonempty stderr line from mcm", () =>
  Effect.gen(function* () {
    const service = yield* McmReleaseService;
    const error = yield* service.read("123", []).pipe(Effect.flip);
    expect(error).toBeInstanceOf(McmReleaseError);
    expect(error.message).toBe("Could not read MCM plan (exit code 1; auth expired)");
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide([
          NodeServices.layer,
          Layer.succeed(HostProcess.Environment, { PATH: "" }),
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              meituanIntegrationEnabled: true,
              meituanRequirementsEnabled: true,
            }),
          }),
          Layer.succeed(ProcessRunner, {
            run: () =>
              Effect.succeed({
                stdout: "",
                stderr: "\n  auth expired  \nfollow-up details",
                code: ExitCode(1),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
          }),
        ]),
      ),
    ),
  ),
);

it("requires successful operations matching the service, target and delivery PR", () => {
  const service = {
    appkey: "acme.api",
    target: "prod",
    revision: "https://github.com/acme/app/pull/1",
  };
  const operation = {
    appKey: service.appkey,
    env: "prod",
    status: "SUCCEED",
    releaseValue: "main",
    prList: [{ link: service.revision }],
  };
  const plan = (op: object) => ({
    id: 123,
    status: 8,
    steps: [{ status: 3, stepOperation: { items: [op] } }],
  });
  expect(readMcmCoverage(plan(operation), [service])).toEqual([
    { ...service, planId: "123", completed: true },
  ]);
  for (const patch of [
    { status: "FAILED" },
    { env: "test" },
    { prList: [{ link: "https://github.com/acme/app/pull/2" }] },
  ]) {
    expect(readMcmCoverage(plan({ ...operation, ...patch }), [service])).toEqual([]);
  }
  expect(readMcmCoverage({ id: 123, status: 8, steps: [] }, [service])).toEqual([]);
});
