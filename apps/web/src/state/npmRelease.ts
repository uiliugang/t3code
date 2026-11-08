import {
  type ServerConfig,
  type ServerNpmReleaseInput,
  ServerNpmReleaseError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const isServerNpmReleaseError = Schema.is(ServerNpmReleaseError);

function unsupportedLookup(config: ServerConfig | null): ServerNpmReleaseError | null {
  if (config === null) {
    return new ServerNpmReleaseError({ reason: "Connect to this server to check releases." });
  }
  return config.environment.capabilities.githubReleaseLookup === true
    ? null
    : new ServerNpmReleaseError({
        reason:
          "This server does not support GitHub release lookups. Update it before checking releases.",
      });
}

export function npmReleaseFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isServerNpmReleaseError(error)
    ? error.message
    : "Could not check this environment's releases. Check the connection.";
}

const releaseEnvironmentIdAtom = Atom.make((get) => {
  const primary = get(primaryEnvironmentIdAtom);
  // With the desktop's local server turned off there is no primary, so a connected server answers.
  const candidates =
    primary === null ? get(environmentSummaries.connectedEnvironmentIdsAtom) : [primary];
  const environmentId =
    candidates.find(
      (id) => unsupportedLookup(get(serverEnvironment.configValueAtom(id))) === null,
    ) ?? candidates[0];
  if (environmentId === undefined) {
    return {
      _tag: "Unavailable" as const,
      error: new ServerNpmReleaseError({ reason: "Connect to a server to check releases." }),
    };
  }
  const unsupported = unsupportedLookup(get(serverEnvironment.configValueAtom(environmentId)));
  return unsupported === null
    ? { _tag: "Ready" as const, environmentId }
    : { _tag: "Unavailable" as const, error: unsupported };
});

const releaseQueryAtom = (input: ServerNpmReleaseInput) =>
  Atom.make((get) => {
    const selection = get(releaseEnvironmentIdAtom);
    if (selection._tag === "Unavailable") return Effect.fail(selection.error);
    const { environmentId } = selection;
    return get
      .result(serverEnvironment.npmRelease({ environmentId, input }), { suspendOnWaiting: true })
      .pipe(
        Effect.map((release) =>
          release === null
            ? null
            : { version: release.version, databaseMigration: release.databaseMigration },
        ),
      );
  }).pipe(Atom.withLabel(`release:${input.source ?? "npm"}:${input.spec}`));

export const githubReleaseAtom = Atom.family((spec: string) =>
  releaseQueryAtom({ spec, source: "github" }),
);

export function refreshGitHubRelease(registry: AtomRegistry.AtomRegistry, spec: string) {
  const selection = registry.get(releaseEnvironmentIdAtom);
  if (selection._tag === "Unavailable") {
    registry.refresh(githubReleaseAtom(spec));
    return;
  }
  registry.refresh(
    serverEnvironment.npmRelease({
      environmentId: selection.environmentId,
      input: { spec, source: "github" },
    }),
  );
}
