import {
  AssetAttachmentNotFoundError,
  ATTACHMENT_TRANSFER_CHUNK_BYTES,
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  AttachmentTransferError,
  type AttachmentCreateUploadUrlInput,
  type AttachmentReadChunkInput,
  type AttachmentWriteChunkInput,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  createAttachmentUpload,
  deletePendingAttachment,
  storeAttachmentUpload,
} from "./AttachmentUpload.ts";
import { openMediaFile, readMediaFileBytes } from "./MediaFile.ts";

interface Upload {
  offset: number;
  readonly size: number;
  readonly expiresAt: number;
  readonly queue: Queue.Queue<Uint8Array, Cause.Done>;
  readonly worker: Fiber.Fiber<void, AttachmentTransferError>;
  readonly writes: Semaphore.Semaphore;
}

const error = (message: string) => new AttachmentTransferError({ message });
const maxConcurrentUploads = 8;

export const makeUploads = Effect.fn("AttachmentTransfer.makeUploads")(function* (
  socketScope: Scope.Scope,
) {
  const uploads = new Map<string, Upload>();
  const starts = yield* Semaphore.make(1);

  const begin = Effect.fn("AttachmentTransfer.begin")(
    function* (input: AttachmentCreateUploadUrlInput) {
      if (uploads.size >= maxConcurrentUploads)
        return yield* error("Too many active attachment uploads.");
      const claims = yield* createAttachmentUpload(input);
      const queue = yield* Queue.bounded<Uint8Array, Cause.Done>(1);
      const writes = yield* Semaphore.make(1);
      const worker = yield* storeAttachmentUpload(claims, Stream.fromQueue(queue)).pipe(
        Effect.mapError(() => error("Could not store the attachment.")),
        Effect.flatMap((result) => (result.ok ? Effect.void : Effect.fail(error(result.detail)))),
        Effect.timeoutOrElse({
          duration: ATTACHMENT_UPLOAD_URL_TTL_MS,
          orElse: () => Effect.fail(error("Attachment upload expired.")),
        }),
        Effect.onError(() => deletePendingAttachment(claims.attachmentId)),
        Effect.interruptible,
        Effect.forkIn(socketScope, { startImmediately: true }),
      );
      uploads.set(claims.attachmentId, {
        offset: 0,
        size: claims.sizeBytes,
        expiresAt: claims.expiresAt,
        queue,
        worker,
        writes,
      });
      worker.addObserver(() => {
        uploads.delete(claims.attachmentId);
        Queue.shutdownUnsafe(queue);
      });
      return { attachmentId: claims.attachmentId };
    },
    Effect.uninterruptible,
    starts.withPermits(1),
  );

  const write = Effect.fn("AttachmentTransfer.write")(function* (input: AttachmentWriteChunkInput) {
    const upload = uploads.get(input.attachmentId);
    if (!upload) return yield* error("Unknown or expired attachment upload.");
    yield* Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) >= upload.expiresAt) {
        yield* Fiber.interrupt(upload.worker);
        return yield* error("Attachment upload expired.");
      }
      const next = input.offset + input.data.byteLength;
      if (
        input.offset !== upload.offset ||
        !input.data.byteLength ||
        input.data.byteLength > ATTACHMENT_TRANSFER_CHUNK_BYTES ||
        next > upload.size
      )
        return yield* error("Invalid attachment chunk offset or length.");
      if (!(yield* Queue.offer(upload.queue, input.data)))
        return yield* error("Attachment upload closed.");
      upload.offset = next;
      if (next === upload.size) {
        yield* Queue.end(upload.queue);
        yield* Fiber.join(upload.worker);
      }
    }).pipe(
      Effect.onInterrupt(() => Fiber.interrupt(upload.worker)),
      upload.writes.withPermits(1),
    );
  });

  const remove = Effect.fn("AttachmentTransfer.remove")(function* (attachmentId: string) {
    const upload = uploads.get(attachmentId);
    if (upload) yield* Fiber.interrupt(upload.worker);
    yield* deletePendingAttachment(attachmentId);
  });
  return { begin, write, remove };
});

export const readChunk = Effect.fn("AttachmentTransfer.readChunk")(function* ({
  attachmentId,
  offset,
  length = ATTACHMENT_TRANSFER_CHUNK_BYTES,
}: AttachmentReadChunkInput) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const missing = () =>
    new AssetAttachmentNotFoundError({ resource: { _tag: "attachment", attachmentId } });
  const dir = yield* fs
    .realPath(config.attachmentsDir)
    .pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "NotFound"
          ? missing()
          : error("Could not open the attachment directory."),
      ),
    );
  const path = resolveAttachmentPathById({ attachmentsDir: dir, attachmentId });
  if (!path) return yield* missing();
  const file = yield* openMediaFile(path).pipe(
    Effect.mapError(({ cause }) =>
      cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        ? missing()
        : error("Could not open the attachment."),
    ),
  );
  if (!file) return yield* missing();
  const totalBytes = Number(file.info.size);
  if (
    !Number.isSafeInteger(totalBytes) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > totalBytes ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > ATTACHMENT_TRANSFER_CHUNK_BYTES
  )
    return yield* error("Invalid attachment range.");
  const count = Math.min(length, totalBytes - offset);
  const data = yield* readMediaFileBytes(path, file, offset, count).pipe(
    Effect.mapError(() => error("Could not read the attachment.")),
  );
  if (data.byteLength !== count) return yield* error("Attachment changed during transfer.");
  return { data, totalBytes };
}, Effect.scoped);
