import { describe, expect, it, vi } from "vite-plus/test";

import { createApkUpdater, type ApkUpdateManifest, type ApkUpdateState } from "./apk-update";

const update = {
  packageName: "com.example.t3code",
  versionCode: 8,
  versionName: "0.0.8",
  url: "https://example.com/t3code-8.apk",
  sha256: "a".repeat(64),
} satisfies ApkUpdateManifest;

function setup(overrides: Partial<Parameters<typeof createApkUpdater>[0]> = {}) {
  const states: ApkUpdateState[] = [];
  const operations: string[] = [];
  const options = {
    packageName: update.packageName,
    versionCode: 7,
    fetchManifest: vi.fn(async (): Promise<unknown> => update),
    download: vi.fn(async () => {
      operations.push("download");
      return "file:///cache/8.apk";
    }),
    install: vi.fn(async () => {
      operations.push("install");
      return "installing" as const;
    }),
    flushPendingWrites: vi.fn(async () => {
      operations.push("flush");
    }),
    isForeground: () => true,
    onStateChange: (state: ApkUpdateState) => states.push(state),
    ...overrides,
  };
  return { updater: createApkUpdater(options), options, states, operations };
}

describe("APK updates", () => {
  it("downloads a newer APK and saves pending work before opening the installer", async () => {
    const { updater, states, operations } = setup();
    await updater.check();
    expect(operations).toEqual(["download", "flush", "install"]);
    expect(states.at(-1)).toEqual({ status: "installing", version: "0.0.8" });
  });

  it.each([7, 6])(
    "keeps version %s without downloading or reinstalling it",
    async (versionCode) => {
      const { updater, states, operations } = setup({
        fetchManifest: async () => ({ ...update, versionCode }),
      });
      await updater.check();
      expect(operations).toEqual([]);
      expect(states.at(-1)).toEqual({ status: "current" });
    },
  );

  it.each([
    { packageName: "com.other.app" },
    { versionCode: 8.5 },
    { versionCode: 0 },
    { url: "http://example.com/app.apk" },
    { url: "https://user:secret@example.com/app.apk" },
    { sha256: "invalid" },
  ])("rejects an invalid release before downloading: %j", async (patch) => {
    const { updater, states, operations } = setup({
      fetchManifest: async () => ({ ...update, ...patch }),
    });
    await updater.check();
    expect(operations).toEqual([]);
    expect(states.at(-1)).toMatchObject({ status: "error" });
  });

  it("coalesces automatic and manual checks", async () => {
    const manifest = Promise.withResolvers<unknown>();
    const { updater, options } = setup({ fetchManifest: vi.fn(() => manifest.promise) });
    const first = updater.check();
    const second = updater.check();
    expect(first).toBe(second);
    manifest.resolve(update);
    await Promise.all([first, second]);
    expect(options.download).toHaveBeenCalledOnce();
    expect(options.install).toHaveBeenCalledOnce();
  });

  it("waits until foreground to install and leaves a canceled installer available for retry", async () => {
    let foreground = false;
    const { updater, options, states } = setup({ isForeground: () => foreground });
    await updater.check();
    expect(options.install).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ status: "ready" });
    foreground = true;
    await updater.foreground();
    expect(options.install).toHaveBeenCalledOnce();
    await updater.foreground();
    expect(options.install).toHaveBeenCalledOnce();
    await updater.install();
    expect(options.install).toHaveBeenCalledTimes(2);
  });

  it("resumes after unknown-source permission without reopening settings after a denial", async () => {
    const install = vi.fn(async () => "permission-required" as const);
    const { updater, states } = setup({ install });
    await updater.check();
    await updater.foreground();
    expect(install).toHaveBeenLastCalledWith(expect.anything(), false);
    expect(states.at(-1)).toMatchObject({ status: "ready", permissionRequired: true });
    await updater.foreground();
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("cancels a download before it can install when automatic updates are disabled", async () => {
    const downloaded = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const { updater, states, options } = setup({
      download: async () => {
        started.resolve();
        return downloaded.promise;
      },
    });
    const checking = updater.check();
    await started.promise;
    updater.cancel();
    const queuedRecheck = updater.check();
    updater.cancel();
    downloaded.resolve("file:///cache/8.apk");
    await Promise.all([checking, queuedRecheck]);
    expect(options.install).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ status: "idle" });
  });

  it("installs a replacement update after a canceled foreground install finishes saving", async () => {
    const flushing = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    const replacementReady = Promise.withResolvers<void>();
    let foreground = false;
    let downloads = 0;
    let readyUpdates = 0;
    const { updater, options } = setup({
      isForeground: () => foreground,
      download: async () => `file:///cache/${++downloads}.apk`,
      flushPendingWrites: async () => {
        flushing.resolve();
        await saved.promise;
      },
      onStateChange: (state) => {
        if (state.status === "ready" && ++readyUpdates === 2) replacementReady.resolve();
      },
    });
    await updater.check();
    foreground = true;
    const firstInstall = updater.foreground();
    await flushing.promise;
    updater.cancel();
    const replacement = updater.check();
    await replacementReady.promise;
    saved.resolve();
    await Promise.all([firstInstall, replacement]);
    expect(options.install).toHaveBeenCalledOnce();
    expect(options.install).toHaveBeenCalledWith(
      { manifest: update, uri: "file:///cache/2.apk" },
      true,
    );
  });

  it("does not install when saving pending drafts fails, and can retry the update", async () => {
    const { updater, states, options } = setup();
    vi.mocked(options.flushPendingWrites).mockRejectedValueOnce(new Error("Disk full"));
    await updater.check();
    expect(options.install).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ status: "error", message: "Disk full" });
    await updater.check();
    expect(options.install).toHaveBeenCalledOnce();
  });
});
