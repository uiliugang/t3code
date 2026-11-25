import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { prepareEnhancedDumboWeb } from "./dumboWebEnhancement.ts";

it.effect("exposes only the card destination and leaves the installed CLI untouched", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const cli = path.join(directory, "dumbo-web");
    yield* fs.makeDirectory(path.join(cli, "bin"), { recursive: true });
    yield* fs.makeDirectory(path.join(cli, "lib"));
    const manifest = path.join(directory, "package.json");
    const entry = path.join(cli, "bin", "dumbo-web.mjs");
    const service = path.join(cli, "lib", "service.mjs");
    const source = `export function normalizeMessage(message, ownUid) {
  return {
    body: message.body ?? null,
  };
}`;
    yield* fs.writeFileString(entry, "");
    yield* fs.writeFileString(service, source);
    yield* fs.writeFileString(manifest, '{"name":"@sailor/dumbo-cdp","version":"0.6.6"}');
    const body = { type: 12, data: "{}" };
    const url = "https://dev.sankuai.com/code/repo-detail/group/repo/pr/123/overview";
    const packet = {
      type: 17,
      body,
      extension: JSON.stringify({ businessInfo: { url }, dynamicContent: { hidden: true } }),
    };
    const enhanced = yield* Effect.scoped(
      Effect.gen(function* () {
        const enhancedEntry = yield* prepareEnhancedDumboWeb(entry);
        const patched = yield* fs.readFileString(
          path.join(path.dirname(enhancedEntry), "..", "lib", "service.mjs"),
        );
        const moduleUrl = `data:text/javascript,${encodeURIComponent(patched)}`;
        const { normalizeMessage } = yield* Effect.promise(() => import(moduleUrl));
        assert.deepStrictEqual(normalizeMessage(packet), {
          body,
          extension: { businessInfo: { url } },
        });
        assert.deepStrictEqual(normalizeMessage({ ...packet, extension: "{" }), { body });
        assert.deepStrictEqual(normalizeMessage({ ...packet, type: 6 }), { body });
        return enhancedEntry;
      }),
    );
    assert.isFalse(yield* fs.exists(enhanced));
    assert.strictEqual(yield* fs.readFileString(service), source);
    yield* fs.writeFileString(manifest, '{"name":"@sailor/dumbo-cdp","version":"0.6.7"}');
    assert.strictEqual((yield* Effect.result(prepareEnhancedDumboWeb(entry)))._tag, "Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);
