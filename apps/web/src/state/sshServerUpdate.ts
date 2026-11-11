import { connectionRoutes, type ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { ServerUpdateTarget } from "@t3tools/client-runtime/state/server";
import {
  type DesktopBridge,
  type EnvironmentId,
  type ServerConfig,
  sessionGrantsScope,
  AuthEnvironmentMaintainScope,
  managedUpdatesDenial,
  ServerSelfUpdateError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

function sshUpdateTarget(entry: ConnectionCatalogEntry | undefined) {
  if (entry === undefined) return undefined;
  for (const route of connectionRoutes(entry)) {
    if (Option.isSome(route.profile) && route.profile.value._tag === "SshConnectionProfile") {
      return route.profile.value.target;
    }
  }
  return undefined;
}

export function canUpdateServerOverSsh(environmentId: EnvironmentId) {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    sshUpdateTarget(
      appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId),
    ) !== undefined
  );
}

export const updateServerOverSsh = Effect.fn("web.ssh.updateServer")(function* (
  input: ServerUpdateTarget,
  config: ServerConfig | null,
) {
  const bridge: DesktopBridge | undefined = window.desktopBridge;
  const target = sshUpdateTarget(
    appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(input.environmentId),
  );
  if (bridge === undefined || target === undefined) return undefined;
  const session = appAtomRegistry.get(environmentSession.sessionStateAtom(input.environmentId));
  const denial = managedUpdatesDenial(
    config?.managedPolicy,
    cliReleaseChannelOf(input.input.targetVersion),
  );
  if (
    session._tag !== "Success" ||
    !session.value.authenticated ||
    !sessionGrantsScope(session.value, AuthEnvironmentMaintainScope)
  ) {
    return yield* new ServerSelfUpdateError({
      reason: "This session cannot update the SSH environment.",
    });
  }
  if (denial !== undefined) return yield* new ServerSelfUpdateError({ reason: denial });
  yield* Effect.tryPromise({
    try: async () => {
      const current = await bridge.ensureSshEnvironment(target, { issuePairingToken: false });
      const descriptor = await bridge.fetchSshEnvironmentDescriptor(current.httpBaseUrl);
      if (descriptor.environmentId !== input.environmentId) {
        throw new Error("The SSH host reaches a different environment. Reconnect before updating.");
      }
      if (current.remoteServerKind === "external") {
        throw new Error(
          "This server was started outside SSH management. Update it manually with its original options; it was left running.",
        );
      }
      await bridge.ensureSshEnvironment(target, { targetVersion: input.input.targetVersion });
    },
    catch: (cause) =>
      new ServerSelfUpdateError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  });
  return { targetVersion: input.input.targetVersion, method: "respawn" as const };
});
