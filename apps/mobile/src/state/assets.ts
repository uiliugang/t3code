import { useEffect, useRef } from "react";
import { sessionDeniesScope } from "@t3tools/client-runtime/state/session";
import { useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  ASSET_URL_MAX_IN_FLIGHT,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  EMPTY_ASSET_URL_ATOM,
  makeRevisionedAssetUrlFamily,
} from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, useMessages } from "gt-react-native";
import { m } from "../i18n/messages";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  type AssetResource,
  type EnvironmentId,
  type WorkspaceFileResource,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Atom, AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { attachmentEnvironment } from "./attachments";
import { projectFaviconDatabaseCache } from "../lib/projectFaviconDatabaseCache";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { appAtomRegistry } from "./atom-registry";
import { environmentProjectCloneListAtom } from "./projectClones";
import { environmentSession, usePreparedConnection } from "./session";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconDatabaseCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectCloneListAtom,
});

const revisionedAssetUrl = makeRevisionedAssetUrlFamily(assetEnvironment.createUrl);

// Only immutable attachments may share a decrypted file without a host revision.
type NoiseFile = string | WorkspaceFileResource;
type NoiseFileTarget = { readonly environmentId: EnvironmentId; readonly file: NoiseFile };

function noiseFileResource(resource: AssetResource | null): NoiseFile | null {
  switch (resource?._tag) {
    case "attachment":
      return resource.attachmentId;
    case "workspace-file":
    case "draft-workspace-file":
    case "media-file":
      return resource;
    default:
      return null;
  }
}

function needsMediaResponse(resource: AssetResource | null) {
  if (!resource) return false;
  const file = noiseFileResource(resource);
  if (file === null) return true;
  if (resource._tag === "attachment")
    return (
      resource.renderIntent === "mcp-app" ||
      resource.mimeType === "text/html" ||
      resource.mimeType === "image/svg+xml" ||
      /\.(?:html?|svg)$/i.test(resource.fileName ?? "")
    );
  return (
    typeof file !== "string" &&
    /\.(?:html?|svg)$/i.test(file.path) &&
    (!("disposition" in file) || file.disposition !== "attachment")
  );
}

const noiseFileAccess = Atom.family(
  ({
    environmentId,
    scope,
  }: {
    readonly environmentId: EnvironmentId;
    readonly scope: typeof AuthFilesystemReadScope | typeof AuthOrchestrationReadScope;
  }) =>
    Atom.make((get) => {
      const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
      return (
        connection._tag === "Some" &&
        connection.value.transport === "noise" &&
        !sessionDeniesScope(get(environmentSession.sessionStateAtom(environmentId)), scope)
      );
    }),
);

const requiredScope = (file: NoiseFile) =>
  typeof file === "string" ? AuthOrchestrationReadScope : AuthFilesystemReadScope;

const openNoiseFileTransfer = Effect.fn("MobileAsset.openNoiseFileTransfer")(function* (
  get: Atom.AtomContext,
  { environmentId, file }: NoiseFileTarget,
) {
  get(environmentCatalog.sessionGenerationAtom(environmentId));
  if (!get(noiseFileAccess({ environmentId, scope: requiredScope(file) }))) {
    return yield* new AssetUrlUnavailableError({
      message: m(msg("The file could not be opened. Check the connection and try again.")),
    });
  }
  return yield* attachmentEnvironment.openNoiseTransfer.run(get.registry, {
    environmentId,
    input: undefined,
  });
});

const workspaceRevision = Atom.family(
  (key: { readonly environmentId: EnvironmentId; readonly file: WorkspaceFileResource }) =>
    Atom.make((get) =>
      openNoiseFileTransfer(get, key).pipe(
        Effect.flatMap((transfer) =>
          transfer.readWorkspaceChunk({ resource: key.file, offset: 0, length: 0 }),
        ),
        Effect.map((chunk) => chunk.revision),
      ),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel("noise-workspace-file-revision")),
);

// A mounted preview follows explicit reauthorization and rechecks the version on a new editor revision.
const previewRevision = Atom.family(
  (key: {
    readonly environmentId: EnvironmentId;
    readonly file: WorkspaceFileResource;
    readonly hint: string;
  }) =>
    Atom.make((get) => {
      const atom = workspaceRevision({ environmentId: key.environmentId, file: key.file });
      const current = get.once(atom);
      if (current._tag !== "Initial" && !current.waiting) get.refresh(atom);
      get.subscribe(atom, (next) => get.setSelf(next));
      return get.once(atom);
    }).pipe(Atom.setIdleTTL(0)),
);

const downloadSlots = Atom.family((_environmentId: EnvironmentId) =>
  Semaphore.makeUnsafe(ASSET_URL_MAX_IN_FLIGHT),
);
const noiseFiles = Atom.family((key: NoiseFileTarget & { readonly revision: string | null }) =>
  Atom.make((get) => {
    const open = openNoiseFileTransfer(get, key);
    return Effect.gen(function* () {
      const transfer = yield* open;
      const { downloadNoiseFile } = yield* Effect.promise(
        () => import("../lib/attachmentDownload"),
      );
      const { file, revision } = key;
      if (typeof file === "string")
        return yield* downloadNoiseFile(file, (offset) =>
          transfer.readChunk({ attachmentId: file, offset }),
        );
      if (revision === null)
        return yield* new AssetUrlUnavailableError({
          message: m(msg("The file could not be opened. Check the connection and try again.")),
        });
      return yield* downloadNoiseFile(
        file.path,
        (offset) => transfer.readWorkspaceChunk({ resource: file, offset, revision }),
        revision,
      );
    }).pipe(downloadSlots(key.environmentId).withPermit);
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel("noise-file")),
);

const noisePreview = Atom.family((key: NoiseFileTarget & { readonly hint: string | null }) =>
  Atom.make((get) =>
    Effect.gen(function* () {
      const { environmentId, file, hint } = key;
      const revision =
        typeof file === "string"
          ? null
          : yield* get.result(
              hint === null
                ? workspaceRevision({ environmentId, file })
                : previewRevision({ environmentId, file, hint }),
              {
                suspendOnWaiting: true,
              },
            );
      const { uri: url } = yield* get.result(noiseFiles({ environmentId, file, revision }), {
        suspendOnWaiting: true,
      });
      return {
        _tag: "Success" as const,
        url,
        expiresAt: Infinity,
        ...(revision === null ? {} : { fileRevision: revision }),
      };
    }),
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel("noise-file-preview")),
);

/**
 * Pass `revision` for a host file whose bytes can change under the same path; each new
 * revision re-mints the URL so the image reloads.
 */
export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision?: string | null,
): AssetUrlState {
  const fileAccessSession = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const messages = useMessages();
  const fileEnvironment = useEnvironmentPresentation(environmentId);
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: fileEnvironment.isReady,
      connection: fileEnvironment.presentation?.connection ?? null,
      session: fileAccessSession.data,
      sessionError: fileAccessSession.error,
    },
    messages,
  );
  const blocked = blockedAssetUrlState(resource, fileAccess);
  const preparedConnection = usePreparedConnection(environmentId);
  const connectionPhase = fileEnvironment.presentation?.connection.phase ?? "available";
  const encrypted =
    preparedConnection._tag === "Some" && preparedConnection.value.transport === "noise";
  const mediaOrigin =
    preparedConnection._tag === "Some" && needsMediaResponse(resource)
      ? preparedConnection.value.mediaOrigins?.asset
      : undefined;
  const file = noiseFileResource(resource);
  const noise =
    encrypted && !mediaOrigin && blocked === null && file !== null && environmentId !== null
      ? noisePreview({ environmentId, file, hint: revision ?? null })
      : null;
  const local = useAtomValue(noise ?? EMPTY_ASSET_URL_ATOM);
  const result = useAtomValue(
    blocked !== null ||
      environmentId === null ||
      resource === null ||
      (encrypted && !mediaOrigin) ||
      (file !== null && preparedConnection._tag === "None")
      ? EMPTY_ASSET_URL_ATOM
      : revision === undefined
        ? assetEnvironment.createUrl({ environmentId, input: { resource } })
        : revisionedAssetUrl({ environmentId, input: { resource }, revision }),
  );
  const shared =
    blocked ??
    (encrypted && !mediaOrigin
      ? local._tag === "Success" && !local.waiting
        ? local.value
        : file === null || (local._tag === "Failure" && !local.waiting)
          ? { _tag: "Failure" as const }
          : { _tag: "Loading" as const }
      : assetUrlStateFromResult(
          result,
          preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
          mediaOrigin,
        ));
  return deriveAssetUrlState({
    connectionPhase,
    shared: shared._tag === "Failure" && result.waiting ? { _tag: "Loading" } : shared,
  });
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

/** Explicit playback and sharing must reauthorize files that may have been replaced on disk. */
export function useRefreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): (signal?: AbortSignal) => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    connection._tag === "Some"
      ? (connection.value.mediaOrigins?.asset ?? connection.value.httpBaseUrl)
      : null;
  const fileKey = JSON.stringify(noiseFileResource(resource));
  const leaseRef = useRef<{ controller: AbortController; release?: () => void } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the on-demand native file lease when its player or share action unmounts
  useEffect(() => {
    const lease: NonNullable<typeof leaseRef.current> = { controller: new AbortController() };
    leaseRef.current = lease;
    return () => {
      lease.controller.abort();
      lease.release?.();
      leaseRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new resource or route releases the previous native file
  }, [environmentId, fileKey, httpBaseUrl]);
  return async (signal) => {
    const lease = leaseRef.current;
    if (!lease || environmentId === null || resource === null || httpBaseUrl === null) return null;
    return refreshAssetUrl(
      environmentId,
      resource,
      signal ?? lease.controller.signal,
      (release) => {
        if (lease.controller.signal.aborted) return release();
        lease.release?.();
        lease.release = release;
      },
    ).catch(() => null);
  };
}

/**
 * {@link useRefreshAssetUrl} for async tasks that resolve several resources at once. Resolves
 * null without a connection and rejects with the server's error when it refuses the URL.
 */
export async function refreshAssetUrl(
  environmentId: EnvironmentId,
  resource: AssetResource,
  signal?: AbortSignal,
  retain?: (release: () => void) => void,
): Promise<string | null> {
  const connectionAtom = environmentSession.preparedConnectionValueAtom(environmentId);
  const initial = appAtomRegistry.get(connectionAtom);
  if (initial._tag === "None") return null;
  const mediaOrigin = needsMediaResponse(resource) ? initial.value.mediaOrigins?.asset : undefined;
  if (initial.value.transport === "noise" && !mediaOrigin) {
    const source = noiseFileResource(resource);
    if (source === null) return null;
    const queryOptions = { reportFailure: false, ...(signal ? { signal } : {}) };
    let revision: string | null = null;
    if (typeof source !== "string") {
      const current = await executeAtomQuery(
        appAtomRegistry,
        workspaceRevision({ environmentId, file: source }),
        { ...queryOptions, refresh: true },
      );
      if (current._tag === "Failure") throw squashAtomCommandFailure(current);
      revision = current.value;
    }
    const file = noiseFiles({ environmentId, file: source, revision });
    const release = appAtomRegistry.mount(file);
    try {
      const cached = appAtomRegistry.get(file);
      let missing = false;
      if (cached._tag === "Success" && !cached.waiting) {
        if (typeof source === "string") {
          await Effect.runPromise(
            attachmentEnvironment.openNoiseTransfer
              .run(appAtomRegistry, { environmentId, input: undefined })
              .pipe(
                Effect.flatMap((transfer) =>
                  transfer.readChunk({ attachmentId: source, offset: 0, length: 0 }),
                ),
              ),
            signal ? { signal } : undefined,
          );
        }
        missing = !cached.value.exists();
      }
      const result = await executeAtomQuery(appAtomRegistry, file, {
        ...queryOptions,
        refresh: cached._tag === "Failure" || missing,
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const active = appAtomRegistry.get(connectionAtom);
      if (signal?.aborted || active._tag === "None" || active.value.transport !== "noise") {
        release();
        return null;
      }
      if (retain) retain(release);
      else setTimeout(release, 30_000);
      return result.value.uri;
    } catch (error) {
      release();
      throw error;
    }
  }
  const atom = assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    label: atom.label?.[0] ?? "asset url",
    refresh: true,
    reportFailure: false,
    ...(signal ? { signal } : {}),
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  // A route can change while the query runs; resolve against the connection now current.
  const connection = appAtomRegistry.get(connectionAtom);
  if (
    connection._tag === "None" ||
    connection.value.transport !== initial.value.transport ||
    connection.value.mediaOrigins !== initial.value.mediaOrigins
  )
    return null;
  const state = assetUrlStateFromResult(result, connection.value.httpBaseUrl, mediaOrigin);
  return state._tag === "Success" ? state.url : null;
}

export interface AuthorizedAssetUrl {
  readonly url: string;
  readonly authorizedAt: number;
}

interface FreshAssetUrlKey {
  readonly environmentId: EnvironmentId | null;
  readonly resource: AssetResource;
  /** A reconnect changes the base URL, and any URL minted against the old one is unusable. */
  readonly httpBaseUrl: string | null;
  /** Bumped by Retry so a file replaced on disk is reauthorized. */
  readonly revision: number;
}

class AssetUrlUnavailableError extends Schema.TaggedError<
  AssetUrlUnavailableError,
  { readonly brand: unique symbol }
>()("AssetUrlUnavailableError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`).
const freshAssetUrlFamily = Atom.family((key: FreshAssetUrlKey) =>
  Atom.make((get) => {
    const file = noiseFileResource(key.resource);
    if (key.environmentId && file !== null) {
      get(environmentCatalog.sessionGenerationAtom(key.environmentId));
      get(noiseFileAccess({ environmentId: key.environmentId, scope: requiredScope(file) }));
    }
    return Effect.tryPromise({
      try: async (signal) =>
        key.environmentId === null
          ? null
          : await refreshAssetUrl(key.environmentId, key.resource, signal, (release) =>
              get.addFinalizer(release),
            ).catch(() => null),
      catch: (cause) =>
        new AssetUrlUnavailableError({
          message: errorDisplayMessage(cause, m) ?? m(msg("The attachment is unavailable.")),
          cause,
        }),
    }).pipe(
      Effect.flatMap((url) =>
        url
          ? Effect.map(Clock.currentTimeMillis, (authorizedAt): AuthorizedAssetUrl => ({
              url,
              authorizedAt,
            }))
          : Effect.fail(
              new AssetUrlUnavailableError({
                message: m(msg("Reconnect to this environment and try again.")),
              }),
            ),
      ),
    );
  }).pipe(Atom.withLabel("fresh-asset-url")),
);

const noFreshAssetUrl = Atom.make(
  AsyncResult.initial<AuthorizedAssetUrl, AssetUrlUnavailableError>(),
).pipe(Atom.withLabel("fresh-asset-url:none"));
const noSessionGeneration = Atom.make(0);

/**
 * A signed URL minted when the reader mounts, not a cached one: cached links can
 * expire while the client is suspended.
 */
export function useFreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision: number,
): AsyncResult.AsyncResult<AuthorizedAssetUrl, Error> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    connection._tag === "Some"
      ? (connection.value.mediaOrigins?.asset ?? connection.value.httpBaseUrl)
      : null;
  const atom =
    resource === null
      ? noFreshAssetUrl
      : freshAssetUrlFamily({ environmentId, resource, httpBaseUrl, revision });
  // Minting fails at once while the environment is unreachable; mint again once a new session is
  // up instead of keeping the error until Retry.
  const sessionGeneration =
    environmentId === null
      ? noSessionGeneration
      : environmentCatalog.sessionGenerationAtom(environmentId);
  // A listener alone does not compute the atom, so nothing would follow the connection.
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => {
    if (AsyncResult.isFailure(appAtomRegistry.get(atom))) appAtomRegistry.refresh(atom);
  });
  return useAtomValue(atom);
}
