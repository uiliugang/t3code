import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class WebhookSendError extends Schema.TaggedError<
  WebhookSendError,
  { readonly brand: unique symbol }
>()("WebhookSendError", { message: Schema.String }) {}

const decodeHeaders = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const send = Command.make("send", {
  addressFile: Flag.String("address-file").pipe(
    Flag.withDescription("File containing the trusted t3hook address."),
  ),
  bodyFile: Flag.String("body-file").pipe(
    Flag.withDescription("File containing the original request body."),
  ),
  headersFile: Flag.String("headers-file").pipe(Flag.optional),
  method: Flag.Literals("method", ["GET", "POST", "PUT", "PATCH"]).pipe(Flag.withDefault("POST")),
  query: Flag.String("query").pipe(Flag.withDefault("")),
}).pipe(
  Command.withHandler(
    Effect.fn("cli.webhook.send")(function* (args) {
      const fs = yield* FileSystem.FileSystem;
      if ((yield* fs.stat(args.bodyFile)).size > 1024 * 1024)
        return yield* new WebhookSendError({ message: "Webhook body exceeds 1 MiB." });
      const address = (yield* fs.readFileString(args.addressFile)).trim();
      const body = yield* fs.readFile(args.bodyFile);
      const headers = Option.isSome(args.headersFile)
        ? yield* decodeHeaders(yield* fs.readFileString(args.headersFile.value))
        : { "content-type": "application/json" };
      const createdAt = yield* Clock.currentTimeMillis;
      const id = yield* (yield* SecureRandom.SecureRandom).uuidV4();
      const { encryptWebhook } = yield* Effect.promise(
        () => import("../scheduledTasks/encryptedWebhook.ts"),
      );
      const sealed = yield* Effect.tryPromise({
        try: () =>
          encryptWebhook(address, {
            id,
            createdAt,
            method: args.method,
            query: args.query,
            headers,
            body,
          }),
        catch: () =>
          new WebhookSendError({
            message: "Could not encrypt the delivery. Check the address and payload size.",
          }),
      });
      const response = yield* HttpClientRequest.post(sealed.url).pipe(
        HttpClientRequest.bodyText(sealed.body, "application/jose"),
        HttpClient.execute,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provide(FetchHttpClient.layer),
        Effect.timeout("30 seconds"),
      );
      if (response.status < 200 || response.status >= 300)
        return yield* new WebhookSendError({
          message: `Encrypted webhook returned HTTP ${response.status}.`,
        });
      yield* Console.log(`HTTP ${response.status}`);
    }),
  ),
);
export const webhookCommand = Command.make("webhook").pipe(Command.withSubcommands([send]));
