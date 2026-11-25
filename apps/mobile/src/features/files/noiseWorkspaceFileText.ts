import type { NoiseAttachmentTransfer } from "@t3tools/client-runtime/state/attachments";
import {
  AttachmentTransferError,
  ATTACHMENT_TRANSFER_CHUNK_BYTES,
  type WorkspaceFileResource,
} from "@t3tools/contracts";
import { decodeFilePreviewText, FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import * as Effect from "effect/Effect";

// Past this size the phone shows a 1 MiB prefix and offers the full file for download.
export const MOBILE_FULL_FILE_MAX_BYTES = 8 * 1024 * 1024;

export const readNoiseWorkspaceFileText = Effect.fn("MobileAsset.readNoiseWorkspaceFileText")(
  function* (
    transfer: Pick<NoiseAttachmentTransfer, "readWorkspaceChunk">,
    resource: WorkspaceFileResource,
  ) {
    const first = yield* transfer.readWorkspaceChunk({ resource, offset: 0 });
    const { totalBytes, revision } = first;
    const limit =
      totalBytes <= MOBILE_FULL_FILE_MAX_BYTES ? totalBytes : FILE_TEXT_PREVIEW_MAX_BYTES;
    const bytes = new Uint8Array(limit);
    let offset = 0;
    let chunk = first;
    while (true) {
      const length = Math.min(ATTACHMENT_TRANSFER_CHUNK_BYTES, limit - offset);
      if (
        chunk.revision !== revision ||
        chunk.totalBytes !== totalBytes ||
        chunk.data.byteLength !== length
      )
        return yield* new AttachmentTransferError({ message: "Invalid workspace file chunk." });
      bytes.set(chunk.data, offset);
      offset += length;
      if (offset === limit) break;
      chunk = yield* transfer.readWorkspaceChunk({
        resource,
        offset,
        revision,
        length: Math.min(ATTACHMENT_TRANSFER_CHUNK_BYTES, limit - offset),
      });
    }
    const decoded = yield* Effect.try({
      try: () => decodeFilePreviewText(bytes, totalBytes > limit, limit),
      catch: (cause) =>
        new AttachmentTransferError({
          message: cause instanceof Error ? cause.message : "Could not decode the file.",
        }),
    });
    return {
      contents: decoded.text,
      byteLength: totalBytes,
      truncated: decoded.truncated,
      relativePath: resource.path,
    };
  },
);
