import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

type BuildArch = "arm64" | "x64" | "universal";

export const getDefaultBuildArch = Effect.fn("getDefaultBuildArch")(function* (
  archChoices: ReadonlyArray<BuildArch>,
) {
  const hostArch = yield* HostProcess.Architecture;
  if ((hostArch === "arm64" || hostArch === "x64") && archChoices.includes(hostArch)) {
    return hostArch;
  }
  return archChoices[0] ?? "x64";
});
