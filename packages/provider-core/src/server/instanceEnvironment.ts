import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { stripAppImageRuntimeEnv } from "@t3tools/shared/appImageRuntimeEnv";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  // Commands the agent runs inherit this env; the AppImage mount's libraries would shadow the system's.
  const hostEnv = stripAppImageRuntimeEnv(baseEnv);
  if (!environment || environment.length === 0) {
    return hostEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...hostEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    const name = variable.name;
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});

export const RESOURCE_ROLE_ENV = "T3CODE_RESOURCE_ROLE";
export const RESOURCE_OWNER_ENV = "T3CODE_RESOURCE_OWNER";

// Encode whitespace so the value is also unambiguous in macOS ps environment output.
export const resourceOwner = (stateDir: string): string => encodeURIComponent(stateDir);
