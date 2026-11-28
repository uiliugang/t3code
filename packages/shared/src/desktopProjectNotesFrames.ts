import { DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class DesktopProjectNotesFrameError extends Schema.TaggedError<
  DesktopProjectNotesFrameError,
  { readonly brand: unique symbol }
>()("DesktopProjectNotesFrameError", {}) {}

// Bound buffering before UTF-8 decoding, including unterminated/malformed frames.
export function desktopProjectNotesLines<E, R>(source: Stream.Stream<Uint8Array, E, R>) {
  return Stream.suspend(() => {
    const bytes = new Uint8Array(DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES - 1);
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let used = 0;
    return source.pipe(
      Stream.mapEffect((chunk) =>
        Effect.try({
          try: () => {
            if (chunk.length > DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES)
              throw new DesktopProjectNotesFrameError();
            const lines: string[] = [];
            let start = 0;
            while (start < chunk.length) {
              const newline = chunk.indexOf(10, start);
              const end = newline === -1 ? chunk.length : newline;
              const part = chunk.subarray(start, end);
              if (used + part.length > bytes.length) throw new DesktopProjectNotesFrameError();
              bytes.set(part, used);
              used += part.length;
              if (newline === -1) break;
              if (used === 0) throw new DesktopProjectNotesFrameError();
              lines.push(utf8.decode(bytes.subarray(0, used)));
              used = 0;
              start = newline + 1;
            }
            return lines;
          },
          catch: () => new DesktopProjectNotesFrameError(),
        }),
      ),
      Stream.flattenIterable,
      Stream.concat(
        Stream.suspend(() =>
          used === 0 ? Stream.empty : Stream.fail(new DesktopProjectNotesFrameError()),
        ),
      ),
    );
  });
}
