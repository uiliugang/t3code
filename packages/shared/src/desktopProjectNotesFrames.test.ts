import { assert, it } from "@effect/vitest";
import { DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { desktopProjectNotesLines } from "./desktopProjectNotesFrames.ts";

it.effect("keeps complete UTF-8 frames and rejects malformed or unbounded data", () =>
  Effect.gen(function* () {
    const utf8 = new TextEncoder();
    const lines = utf8.encode("笔记\n2\n");
    const got = yield* desktopProjectNotesLines(
      Stream.make(lines.slice(0, 1), lines.slice(1)),
    ).pipe(Stream.runCollect);
    assert.deepEqual(got, ["笔记", "2"]);
    for (const input of [
      Stream.make(Uint8Array.of(255, 10)),
      Stream.make(utf8.encode("partial")),
      Stream.make(
        new Uint8Array(DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES - 1).fill(65),
        Uint8Array.of(65, 10),
      ),
    ]) {
      assert.equal(
        (yield* Effect.exit(desktopProjectNotesLines(input).pipe(Stream.runCollect)))._tag,
        "Failure",
      );
    }
  }),
);
