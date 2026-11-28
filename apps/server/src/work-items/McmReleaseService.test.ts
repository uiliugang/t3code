import { expect, it } from "@effect/vitest";
import { McmReleaseError, readMcmCoverage } from "./McmReleaseService.ts";

it("surfaces the underlying error message on McmReleaseError", () => {
  expect(
    new McmReleaseError({ cause: new Error("Could not read MCM plan (exit code 1; auth expired)") })
      .message,
  ).toBe("Could not read MCM plan (exit code 1; auth expired)");
  expect(new McmReleaseError({ cause: "raw failure" }).message).toBe("raw failure");
  expect(new McmReleaseError({ cause: {} }).message).toBe("MCM release query failed.");
});

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
