// @effect-diagnostics nodeBuiltinImport:off - Exercises Node's writable callbacks and listener lifecycle.
import * as NodeStream from "node:stream";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { writeProjectNotesReply } from "./DesktopProjectNotesPipe.ts";

it.effect("releases the pipe listeners after each reply", () =>
  Effect.gen(function* () {
    const pipe = new NodeStream.Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const reply = new TextEncoder().encode("{}\n");
    yield* writeProjectNotesReply(pipe, reply);
    yield* writeProjectNotesReply(pipe, reply);
    assert.equal(pipe.listenerCount("close"), 0);
    assert.equal(pipe.listenerCount("error"), 0);
  }),
);
