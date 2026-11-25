import type {
  AssetResource,
  EnvironmentId,
  ThreadId,
  WorkspaceFileResource,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useAssetUrlState } from "../../state/assets";

import { environmentCatalog } from "../../connection/catalog";
import { attachmentEnvironment } from "../../state/attachments";
import { readNoiseWorkspaceFileText, MOBILE_FULL_FILE_MAX_BYTES } from "./noiseWorkspaceFileText";

const encryptedTextByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((resource: WorkspaceFileResource) =>
    Atom.make((get) => {
      get(environmentCatalog.sessionGenerationAtom(environmentId));
      return attachmentEnvironment.openNoiseTransfer
        .run(get.registry, { environmentId, input: undefined })
        .pipe(Effect.flatMap((transfer) => readNoiseWorkspaceFileText(transfer, resource)));
    }).pipe(Atom.setIdleTTL(0)),
  ),
);

export const encryptedWorkspaceText = (
  environmentId: EnvironmentId,
  resource: WorkspaceFileResource,
) => encryptedTextByEnvironment(environmentId)(resource);

/**
 * A refresh can keep the URL, so the key also carries the revision it downloads for. No idle TTL:
 * the revision cannot see a same-size edit, so a reopened file downloads its text again.
 */
const fullFileTextAtom = Atom.family((key: string) => {
  const [uri] = JSON.parse(key) as [string, string];
  return connectionAtomRuntime
    .atom(
      HttpClient.get(uri).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => {
          // The file can grow after the preview read; never buffer past the cap. React Native's
          // fetch buffers the whole body, so a response without a length is refused, not trusted.
          const length = Number(response.headers["content-length"] ?? Number.NaN);
          return Number.isFinite(length) && length <= MOBILE_FULL_FILE_MAX_BYTES
            ? response.text
            : Effect.succeed(null);
        }),
        Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
      ),
    )
    .pipe(Atom.withLabel(`full-file-text:${key}`));
});

const noFullFileTextAtom = Atom.make(AsyncResult.success(null));

/**
 * Downloads a thread file's full text past the 1 MB RPC preview; null while loading, after a
 * failure, or when disabled. A new `revision` downloads it again.
 */
export function useFullFileText(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly absolutePath: string | null;
  readonly revision: string;
}): string | null {
  const { threadId, absolutePath } = input;
  // Workspace-file URLs serve only previewable types; an attachment download serves any file.
  const resource = useMemo<AssetResource | null>(
    () =>
      threadId === null || absolutePath === null
        ? null
        : { _tag: "media-file", threadId, path: absolutePath, disposition: "attachment" },
    [threadId, absolutePath],
  );
  const assetUrl = useAssetUrlState(input.environmentId, resource, input.revision);
  const uri = resource !== null && assetUrl._tag === "Success" ? assetUrl.url : null;
  const result = useAtomValue(
    uri === null ? noFullFileTextAtom : fullFileTextAtom(JSON.stringify([uri, input.revision])),
  );
  // The caller keeps showing the 1 MB preview and its partial-file notice.
  return AsyncResult.isSuccess(result) ? result.value : null;
}
