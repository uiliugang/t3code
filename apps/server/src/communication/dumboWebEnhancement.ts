import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodePackage = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.Literal("@sailor/dumbo-cdp"), version: Schema.Literal("0.6.6") }),
  ),
);
const messageStart = "export function normalizeMessage(message, ownUid) {";
const messageBody = "    body: message.body ?? null,";

export const prepareEnhancedDumboWeb = Effect.fn("DumboWeb.prepareEnhancement")(function* (
  entry: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!entry) return yield* Effect.fail("Unsupported dumbo-web launcher");
  const cliDirectory = path.dirname(path.dirname(entry));
  if (
    entry !== path.join(cliDirectory, "bin", "dumbo-web.mjs") ||
    path.basename(cliDirectory) !== "dumbo-web"
  ) {
    return yield* Effect.fail("Unsupported dumbo-web layout");
  }
  const manifest = yield* fs.readFileString(path.join(path.dirname(cliDirectory), "package.json"));
  yield* decodePackage(manifest);
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dumbo-web-" });
  const copy = path.join(temp, "dumbo-web");
  yield* fs.copy(cliDirectory, copy);
  const service = path.join(copy, "lib", "service.mjs");
  const copyEntry = path.join(copy, "bin", "dumbo-web.mjs");
  const copyRoot = yield* fs.realPath(temp);
  if (
    (yield* fs.realPath(service)) !== path.join(copyRoot, "dumbo-web", "lib", "service.mjs") ||
    (yield* fs.realPath(copyEntry)) !== path.join(copyRoot, "dumbo-web", "bin", "dumbo-web.mjs")
  ) {
    return yield* Effect.fail("Unsupported dumbo-web copy layout");
  }
  const source = yield* fs.readFileString(service);
  const start = source.indexOf(messageStart);
  const body = source.indexOf(messageBody);
  if (
    start < 0 ||
    body < start ||
    source.lastIndexOf(messageStart) !== start ||
    source.lastIndexOf(messageBody) !== body
  ) {
    return yield* Effect.fail("Unsupported dumbo-web message format");
  }
  yield* fs.writeFileString(path.join(temp, "package.json"), manifest);
  yield* fs.writeFileString(
    service,
    source
      .replace(
        messageStart,
        `${messageStart}
  let cardUrl;
  if (message.type === 17 && message.body?.type === 12 && message.extension) {
    try {
      const url = JSON.parse(message.extension)?.businessInfo?.url;
      if (typeof url === "string" && /^https?:\\/\\//i.test(url)) cardUrl = url;
    } catch {}
  }`,
      )
      .replace(
        messageBody,
        `${messageBody}
    ...(cardUrl ? { extension: { businessInfo: { url: cardUrl } } } : {}),`,
      ),
  );
  return copyEntry;
});
