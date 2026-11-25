import { expect, it } from "@effect/vitest";
import { ATTACHMENT_TRANSFER_CHUNK_BYTES } from "@t3tools/contracts";
import { FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import * as Effect from "effect/Effect";
import { MOBILE_FULL_FILE_MAX_BYTES, readNoiseWorkspaceFileText } from "./noiseWorkspaceFileText";

const resource = {
  _tag: "draft-workspace-file",
  cwd: "/repo",
  path: "notes",
  disposition: "attachment",
} as const;

it.effect(
  "reads a small whole file and a bounded UTF-8 prefix of a large file from one revision",
  () =>
    Effect.gen(function* () {
      for (const totalBytes of [
        0,
        FILE_TEXT_PREVIEW_MAX_BYTES + 19,
        MOBILE_FULL_FILE_MAX_BYTES + 1,
      ]) {
        const expected = Math.min(
          totalBytes,
          totalBytes > MOBILE_FULL_FILE_MAX_BYTES ? FILE_TEXT_PREVIEW_MAX_BYTES : totalBytes,
        );
        let readBytes = 0;
        const result = yield* readNoiseWorkspaceFileText(
          {
            readWorkspaceChunk: (request) =>
              Effect.sync(() => {
                expect(request.offset).toBe(readBytes);
                expect(request.revision).toBe(readBytes > 0 ? "revision-one" : undefined);
                const data = new Uint8Array(
                  Math.min(
                    request.length ?? ATTACHMENT_TRANSFER_CHUNK_BYTES,
                    totalBytes - request.offset,
                  ),
                ).fill(97);
                readBytes += data.length;
                if (readBytes === expected && totalBytes > expected) data[data.length - 1] = 0xe2;
                return { data, totalBytes, revision: "revision-one" };
              }),
          },
          resource,
        );
        expect(readBytes).toBe(expected);
        expect(result.byteLength).toBe(totalBytes);
        expect(result.truncated).toBe(expected !== totalBytes);
        expect(result.contents.length).toBe(expected - Number(result.truncated));
      }
    }),
);

it.effect("rejects a replaced file before publishing its second chunk", () =>
  Effect.gen(function* () {
    const totalBytes = ATTACHMENT_TRANSFER_CHUNK_BYTES + 1;
    const failure = yield* readNoiseWorkspaceFileText(
      {
        readWorkspaceChunk: ({ offset }) =>
          Effect.succeed({
            totalBytes,
            data: new Uint8Array(offset ? 1 : ATTACHMENT_TRANSFER_CHUNK_BYTES),
            revision: offset ? "replacement" : "first",
          }),
      },
      resource,
    ).pipe(Effect.flip);
    expect(failure.message).toBe("Invalid workspace file chunk.");
  }),
);
