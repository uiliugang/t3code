#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Argument, Command } from "effect/cli";

import { mergeUpdateManifestFiles } from "./merge-update-manifests.ts";

interface ReleaseUpdateManifestMerge {
  readonly primary: string;
  readonly secondary: string;
  readonly output: string;
}

function pairArchitectures(
  platformLabel: string,
  arm64: ReadonlyMap<string, string>,
  x64: ReadonlyMap<string, string>,
): ReadonlyArray<{ readonly channel: string; readonly arm64: string; readonly x64: string }> {
  const channels = new Set([...arm64.keys(), ...x64.keys()]);
  if (channels.size === 0) {
    throw new Error(
      `Incomplete ${platformLabel} updater manifests: no architecture manifests found.`,
    );
  }
  return [...channels].toSorted().map((channel) => {
    const arm64Manifest = arm64.get(channel);
    const x64Manifest = x64.get(channel);
    if (arm64Manifest === undefined || x64Manifest === undefined) {
      const missing = arm64Manifest === undefined ? "arm64" : "x64";
      throw new Error(
        `Incomplete ${platformLabel} updater manifests: ${channel} is missing its ${missing} manifest.`,
      );
    }
    return { channel, arm64: arm64Manifest, x64: x64Manifest };
  });
}

function planReleaseUpdateManifestMerges(
  fileNames: ReadonlyArray<string>,
): ReadonlyArray<ReleaseUpdateManifestMerge> {
  const macArm64 = new Map<string, string>();
  const macX64 = new Map<string, string>();

  for (const fileName of fileNames) {
    if (fileName.startsWith("builder-debug")) continue;

    const macArm64Match = /^(.+)-mac\.yml$/u.exec(fileName);
    if (macArm64Match?.[1] !== undefined) {
      macArm64.set(macArm64Match[1], fileName);
      continue;
    }
    const macX64Match = /^(.+)-mac-x64\.yml$/u.exec(fileName);
    if (macX64Match?.[1] !== undefined) {
      macX64.set(macX64Match[1], fileName);
    }
  }

  // electron-builder names the macOS arm64 manifest without an arch suffix.
  return pairArchitectures("macOS", macArm64, macX64).map(({ arm64, x64 }) => ({
    primary: arm64,
    secondary: x64,
    output: arm64,
  }));
}

export const mergeReleaseUpdateManifestFiles = Effect.fn("mergeReleaseUpdateManifestFiles")(
  function* (releaseAssetsDirArg: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const releaseAssetsDir = path.resolve(releaseAssetsDirArg);
    const plans = planReleaseUpdateManifestMerges(yield* fs.readDirectory(releaseAssetsDir));

    yield* Effect.forEach(
      plans,
      (plan) => {
        const primary = path.join(releaseAssetsDir, plan.primary);
        const secondary = path.join(releaseAssetsDir, plan.secondary);
        const output = path.join(releaseAssetsDir, plan.output);
        return mergeUpdateManifestFiles("mac", primary, secondary, output).pipe(
          Effect.andThen(
            Effect.forEach(
              [primary, secondary].filter((source) => source !== output),
              (source) => fs.remove(source),
              { discard: true },
            ),
          ),
        );
      },
      { discard: true },
    );
  },
);

export const mergeReleaseUpdateManifestsCommand = Command.make(
  "merge-release-update-manifests",
  {
    releaseAssetsDir: Argument.String("release-assets-dir").pipe(
      Argument.withDescription("Directory containing every desktop release artifact."),
    ),
  },
  ({ releaseAssetsDir }) => mergeReleaseUpdateManifestFiles(releaseAssetsDir),
).pipe(
  Command.withDescription("Require and merge complete macOS arm64/x64 updater manifest pairs."),
);

if (import.meta.main) {
  Command.run(mergeReleaseUpdateManifestsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
