import type { ProjectFaviconTarget } from "@t3tools/client-runtime/project-favicon-cache";
import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  projectFaviconResource,
} from "@t3tools/client-runtime/state/assets";
import { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AsyncResult, Atom } from "effect/reactivity";
import { ASSET_URL_MAX_IN_FLIGHT } from "@t3tools/client-runtime/state/assets";
import { downloadNoiseAsset, localAssetUrl } from "../assets/noiseAsset";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { previewPdfAssetUrl } from "@t3tools/shared/preview";
import { projectFaviconCache } from "../assets/projectFaviconCache";
import { isElectron } from "../env";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentProjectClonesAtom } from "./projectClones";
import { environmentSession } from "./session";

const localMediaEnvironment = Atom.make((get) => {
  if (!isElectron) return null;
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
  const config = get(environmentSession.initialConfigValueAtom(environmentId));
  return connection._tag === "None" || config === null
    ? null
    : { environmentId, httpBaseUrl: connection.value.httpBaseUrl };
});

const signedAssets = createAssetEnvironmentAtoms(connectionAtomRuntime, localMediaEnvironment);

const slots = Atom.family((_environmentId: EnvironmentId) =>
  Semaphore.makeUnsafe(ASSET_URL_MAX_IN_FLIGHT),
);
const decryptedUrl = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((path: string) =>
    connectionAtomRuntime
      .atom((get) =>
        Effect.gen(function* () {
          const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
          const blob = yield* downloadNoiseAsset(
            connection._tag === "Some" ? connection.value.browserMedia : undefined,
            path,
          );
          const url = yield* localAssetUrl(blob);
          if (url.startsWith("blob:")) get.addFinalizer(() => URL.revokeObjectURL(url));
          return url;
        }).pipe(slots(environmentId).withPermit),
      )
      .pipe(Atom.setIdleTTL("1 minute")),
  ),
);

export const previewPdfUrlAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((url: string | null) =>
    Atom.make((get) => {
      const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (!url || connection._tag === "None") return null;
      const pdf = previewPdfAssetUrl(url, connection.value.httpBaseUrl);
      if (!pdf || connection.value.transport !== "noise") return pdf;
      const { pathname, hash } = new URL(pdf);
      const origin = connection.value.mediaOrigins?.asset;
      if (origin) return origin + pathname + hash;
      const result = get(decryptedUrl(environmentId)(pathname));
      return result._tag === "Success" ? result.value + hash : null;
    }),
  ),
);
const decodeTarget = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, AssetResource]));
const resolvedAsset = Atom.family((key: string) => {
  const [environmentId, resource] = decodeTarget(JSON.parse(key));
  const signed = signedAssets.createUrl({ environmentId, input: { resource } });
  return Atom.transform(
    signed,
    (get) => {
      const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
      const result = get(signed);
      if (
        connection._tag === "None" ||
        connection.value.transport !== "noise" ||
        result._tag !== "Success"
      )
        return result;
      const localAssetOrigin = connection.value.mediaOrigins?.asset;
      if (localAssetOrigin) {
        return AsyncResult.map(result, (value) => ({
          ...value,
          relativeUrl: localAssetOrigin + value.relativeUrl,
        }));
      }
      const local = get(decryptedUrl(environmentId)(result.value.relativeUrl));
      return AsyncResult.map(local, (relativeUrl) => ({ ...result.value, relativeUrl }));
    },
    { initialValueTarget: signed },
  );
});
const createUrl = (target: Parameters<typeof signedAssets.createUrl>[0]) =>
  resolvedAsset(JSON.stringify([target.environmentId, target.input.resource]));
const decodeResources = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);
const resolvedAssets = Atom.family((key: string) => {
  const [environmentId, resources] = decodeResources(JSON.parse(key));
  return Atom.make((get) =>
    resources.map((resource) => get(createUrl({ environmentId, input: { resource } }))),
  );
});

export const assetEnvironment = {
  createUrl,
  verifyUrl: signedAssets.createUrl,
  createUrls: (target: Parameters<typeof signedAssets.createUrls>[0]) =>
    resolvedAssets(JSON.stringify([target.environmentId, target.resources])),
};

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectClonesAtom,
});

/**
 * Asks the server for a project's icon again. Choosing the icon path a project had before would
 * otherwise reuse that path's cached URL, which says "missing" if the file did not exist then.
 */
export function refreshProjectFaviconUrl(target: ProjectFaviconTarget) {
  appAtomRegistry.refresh(
    assetEnvironment.createUrl({
      environmentId: target.environmentId,
      input: { resource: projectFaviconResource(target.cwd, target.faviconPath) },
    }),
  );
}
