import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { getDefaultBuildArch } from "./build-target-arch.ts";

describe("build-target-arch", () => {
  it.effect.each(["x64", "arm64"] as const)(
    "selects the supported native %s architecture",
    (arch) =>
      Effect.gen(function* () {
        const result = yield* getDefaultBuildArch(["arm64", "x64", "universal"]).pipe(
          Effect.provideService(HostProcess.Architecture, arch),
        );
        assert.equal(result, arch);
      }),
  );

  it.effect(
    "falls back to the first available target when the native architecture is unavailable",
    () =>
      Effect.gen(function* () {
        const result = yield* getDefaultBuildArch(["x64", "arm64"]).pipe(
          Effect.provideService(HostProcess.Architecture, "ppc64"),
        );
        assert.equal(result, "x64");
      }),
  );
});
