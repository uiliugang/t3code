import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";

it("generates a complete cached splash image while another theme is still writing", async () => {
  const requireSplash = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("expo-splash-screen/package.json"),
  );
  const {
    generateImageAsync,
    compositeImagesAsync,
  }: {
    generateImageAsync: (
      options: { projectRoot: string; cacheType: string },
      image: { src: string; width: number; height: number; resizeMode: string },
    ) => Promise<{ source: Buffer }>;
    compositeImagesAsync: (images: { foreground: Buffer; background: Buffer }) => Promise<Buffer>;
  } = requireSplash("@expo/image-utils");
  const projectRoot = await NodeFS.promises.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "expo-image-cache-"),
  );
  const options = { projectRoot, cacheType: NodePath.basename(projectRoot) };
  const image = {
    src: NodeURL.fileURLToPath(new URL("../assets/android-splash-icon-prod.png", import.meta.url)),
    width: 288,
    height: 288,
    resizeMode: "contain",
  };
  const writeStarted = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const writeFile = NodeFS.promises.writeFile;
  let blocked = false;
  const writeSpy = vi
    .spyOn(NodeFS.promises, "writeFile")
    .mockImplementation(async (file, data, config) => {
      if (
        blocked ||
        typeof file !== "string" ||
        !file.startsWith(`${projectRoot}${NodePath.sep}`)
      ) {
        return writeFile(file, data, config);
      }
      blocked = true;
      const handle = await NodeFS.promises.open(
        file,
        config && typeof config === "object" ? (config.flag ?? "w") : "w",
      );
      try {
        writeStarted.resolve();
        await releaseWrite.promise;
        await writeFile(handle, data, config);
      } finally {
        await handle.close();
      }
    });
  let first: ReturnType<typeof generateImageAsync> | undefined;
  try {
    first = generateImageAsync(options, image);
    await Promise.race([
      writeStarted.promise,
      first.then(() => {
        throw new Error("Splash image generation did not reach its cache write");
      }),
    ]);
    const concurrent = await generateImageAsync(options, image);
    const background = await NodeFS.promises.readFile(image.src);
    const composed = await compositeImagesAsync({ foreground: concurrent.source, background });
    expect(composed.length).toBeGreaterThan(0);

    releaseWrite.resolve();
    const completed = await first;
    const cached = await generateImageAsync(options, image);
    expect(concurrent.source).toEqual(completed.source);
    expect(cached.source).toEqual(completed.source);
  } finally {
    releaseWrite.resolve();
    try {
      await first;
    } finally {
      writeSpy.mockRestore();
      await NodeFS.promises.rm(projectRoot, { recursive: true, force: true });
    }
  }
});
