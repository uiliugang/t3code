import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { providerConnectionConfigurations } from "./providerConnectionProfiles.ts";

const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));

export const configuredBinaryPaths = Effect.fn("ProviderInstallation.configuredBinaryPaths")(
  function* (entries: ProviderInstanceConfigMap) {
    const paths = new Set<string>();
    const home = yield* HostProcess.HomeDirectory;
    for (const { config, environment } of Object.values(entries).flatMap(
      providerConnectionConfigurations,
    )) {
      if (!hasBinaryPath(config)) continue;
      const binary = expandHomePath(config.binaryPath.trim(), home);
      if (!binary) continue;
      paths.add(binary);
      const resolved = yield* resolveCommandPath(binary, {
        env: yield* mergeProviderInstanceEnvironment(environment),
      });
      if (resolved !== null) paths.add(resolved);
    }
    return [...paths];
  },
);
