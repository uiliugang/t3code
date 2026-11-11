import { connectionRoutes, type ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { ServerUpdateTarget } from "@t3tools/client-runtime/state/server";
import {
  type DesktopBridge,
  type EnvironmentId,
  sessionGrantsScope,
  AuthEnvironmentMaintainScope,
  managedUpdatesDenial,
  ServerSelfUpdateError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
) {
  const bridge: DesktopBridge | undefined = window.desktopBridge;
  const target = sshUpdateTarget(
    appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(input.environmentId),
  );
  if (bridge === undefined || target === undefined) return undefined;
  const session = appAtomRegistry.get(environmentSession.sessionStateAtom(input.environmentId));
  const config = appAtomRegistry.get(
    environmentSession.initialConfigValueAtom(input.environmentId),
  );
  if (
    session._tag !== "Success" ||
    !session.value.authenticated ||
    !sessionGrantsScope(session.value, AuthEnvironmentMaintainScope) ||
    managedUpdatesDenial(config?.managedPolicy) !== undefined
  ) {
    return yield* new ServerSelfUpdateError({
      reason: "This session cannot update the SSH environment.",
    });
  }
  yield* Effect.tryPromise({
    try: async () => {
      const current = await bridge.ensureSshEnvironment(target, { issuePairingToken: false });
      const descriptor = await bridge.fetchSshEnvironmentDescriptor(current.httpBaseUrl);
      if (descriptor.environmentId !== input.environmentId) {
        throw new Error("The SSH host reaches a different environment. Reconnect before updating.");
      }
      await bridge.ensureSshEnvironment(target, { targetVersion: input.input.targetVersion });
    },
    catch: (cause) =>
      new ServerSelfUpdateError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  });
  return { targetVersion: input.input.targetVersion, method: "respawn" as const };
});
