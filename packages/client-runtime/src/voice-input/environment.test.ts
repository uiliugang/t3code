import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  EnvironmentId,
  WS_METHODS,
  type EnvironmentSpeechModel,
  type NoiseHttpRequest,
} from "@t3tools/contracts";
import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { makeNoiseHttpClient } from "../rpc/noiseHttp.ts";
import {
  installEnvironmentSpeechModel,
  setCloudSpeechKey,
  transcribeCloudPcm,
  transcribeEnvironmentPcm,
} from "./environment.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PREPARED: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.test",
  socketUrl: "wss://remote.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "token" },
  target: new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Remote environment",
    connectionId: "connection-1",
  }),
};

const model = (
  state: EnvironmentSpeechModel["state"],
  active: boolean,
): EnvironmentSpeechModel => ({
  id: "voxtral-mini",
  name: "Voxtral Mini",
  description: "",
  size: 1,
  languages: ["en"],
  accuracy: 1,
  speed: 1,
  recommended: false,
  supportsStreaming: false,
  supportsLanguageDetection: false,
  supportsTranslation: false,
  active,
  state,
});

describe("installEnvironmentSpeechModel", () => {
  it.effect.each([
    {
      name: "keeps the current model after a cancelled download",
      downloaded: model("downloadable", false),
      selects: false,
    },
    {
      name: "selects the model once its download finishes",
      downloaded: model("installed", false),
      selects: true,
    },
    {
      name: "leaves a model already in use alone",
      downloaded: model("installed", true),
      selects: false,
    },
  ])("$name", ({ downloaded, selects }) =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const client = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        const answer = path.endsWith("/select") ? model("installed", true) : downloaded;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ models: [answer] })),
        );
      });

      const { models } = yield* installEnvironmentSpeechModel(PREPARED, downloaded.id).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(paths).toEqual([
        "/api/voice/models/download",
        ...(selects ? ["/api/voice/models/select"] : []),
      ]);
      expect(models[0]?.active).toBe(selects || downloaded.active);
    }),
  );

  it.effect("keeps the current model when cancellation leaves the weights installed", () =>
    Effect.gen(function* () {
      const downloaded = model("installed", false);
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              new URL(request.url).pathname.endsWith("/select")
                ? { models: [model("installed", true)] }
                : { models: [downloaded], cancelled: true },
            ),
          ),
        ),
      );
      const { models } = yield* installEnvironmentSpeechModel(PREPARED, downloaded.id).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(models).toEqual([downloaded]);
    }),
  );
});

it.effect("sends PCM, cloud model selection and key edits through the pinned environment", () =>
  Effect.gen(function* () {
    const requests: Array<typeof NoiseHttpRequest.Type> = [];
    const prepared: PreparedConnection = {
      ...PREPARED,
      transport: "noise",
      noiseHttpClient: makeNoiseHttpClient({
        [WS_METHODS.serverNoiseHttpUpload]: () => Effect.die("Unexpected upload"),
        [WS_METHODS.serverNoiseHttp]: (request) => {
          requests.push(request);
          if (request.path.endsWith("/key")) return Stream.make({ status: 204, contentType: "" });
          return Stream.make(
            { status: 200, contentType: "application/json" },
            { data: new TextEncoder().encode(JSON.stringify({ text: "transcribed" })) },
          );
        },
      }),
    };
    const pcm = Uint8Array.of(0, 12, 34, 255);
    const options = DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS;
    const direct = HttpClient.make(() => Effect.die("Unexpected direct voice request"));
    yield* Effect.gen(function* () {
      expect((yield* transcribeEnvironmentPcm(prepared, pcm, options, () => true)).text).toBe(
        "transcribed",
      );
      expect(
        (yield* transcribeCloudPcm(
          prepared,
          "openrouter",
          pcm,
          options,
          () => true,
          "author/model",
        )).text,
      ).toBe("transcribed");
      yield* setCloudSpeechKey(prepared, "openai", "private-api-key");
    }).pipe(Effect.provideService(HttpClient.HttpClient, direct));
    expect(requests.map((r) => r.path)).toEqual([
      "/api/voice/transcribe",
      "/api/voice/cloud/openrouter/transcribe?model=author%2Fmodel",
      "/api/voice/cloud/openai/key",
    ]);
    for (const audio of requests.slice(0, 2)) {
      expect(audio.contentType).toBe("application/octet-stream");
      expect(decodeSpeechPcmRequest(audio.body!)).toEqual({ pcm, options });
    }
    expect(JSON.parse(new TextDecoder().decode(requests[2]?.body))).toEqual({
      key: "private-api-key",
    });
  }),
);
