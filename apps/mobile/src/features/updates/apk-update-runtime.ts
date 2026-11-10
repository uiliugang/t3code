import { requireNativeModule } from "expo";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import { AsyncResult, Atom } from "effect/reactivity";
import { AppState, Platform } from "react-native";
import { reportAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { flushPendingAppWrites } from "./app-updates";
import { createApkUpdater, requireHttpsUpdateUrl, type ApkUpdateState } from "./apk-update";

const updateUrl: unknown = Constants.expoConfig?.extra?.androidApkUpdateUrl;
export const apkUpdatesAvailable = Platform.OS === "android" && typeof updateUrl === "string";
export const apkUpdateStateAtom = Atom.make<ApkUpdateState>({ status: "idle" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:apk-update"),
);

interface NativeApkInstaller {
  installApkUpdate(
    uri: string,
    versionCode: number,
    sha256: string,
    requestPermission: boolean,
  ): Promise<"installing" | "permission-required">;
}

const updater = apkUpdatesAvailable
  ? createApkUpdater({
      packageName: Application.applicationId ?? "",
      versionCode: Number(Application.nativeBuildVersion),
      async fetchManifest(signal) {
        const result = await settlePromise(async () => {
          const response = await fetch(requireHttpsUpdateUrl(String(updateUrl)), {
            signal,
            cache: "no-store",
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}.`);
          return response.json();
        });
        if (result._tag === "Failure") {
          if (!signal.aborted) reportAtomCommandResult(result, { label: "APK update check" });
          throw new Error("Could not check for APK updates.");
        }
        return result.value;
      },
      async download(manifest, signal) {
        const directory = new Directory(Paths.cache, "t3-apk-updates");
        directory.create({ idempotent: true, intermediates: true });
        const file = new File(directory, `${manifest.versionCode}-${manifest.sha256}.apk`);
        if (file.exists) return file.uri;
        for (const entry of directory.list()) entry.delete();
        const partial = new File(directory, "download.partial");
        try {
          await File.downloadFileAsync(manifest.url, partial, { signal });
          signal.throwIfAborted();
          partial.move(file);
          return file.uri;
        } catch (error) {
          if (partial.exists) partial.delete();
          if (signal.aborted) throw error;
          console.warn("[apk-updates] download failed", {
            error,
            versionCode: manifest.versionCode,
          });
          throw new Error("Could not download the APK update.", { cause: error });
        }
      },
      async install({ manifest, uri }, requestPermission) {
        const result = await settlePromise(() =>
          requireNativeModule<NativeApkInstaller>("T3ApkUpdates").installApkUpdate(
            uri,
            manifest.versionCode,
            manifest.sha256,
            requestPermission,
          ),
        );
        if (result._tag === "Failure") {
          const file = new File(uri);
          if (file.exists) file.delete();
          reportAtomCommandResult(result, { label: "APK installation" });
          throw new Error(
            "Could not install the APK update. Check its package name, signing key, and checksum.",
          );
        }
        return result.value;
      },
      flushPendingWrites: flushPendingAppWrites,
      isForeground: () => AppState.currentState === "active",
      onStateChange: (state) => appAtomRegistry.set(apkUpdateStateAtom, state),
    })
  : undefined;

export function checkForApkUpdate() {
  return updater?.check();
}

export function installDownloadedApkUpdate() {
  return updater?.install();
}

export function installApkUpdateChecks(): () => void {
  if (!updater) return () => undefined;
  let enabled = false;
  let backgroundedAt: number | undefined;
  const checkAutomatically = () => {
    const state = appAtomRegistry.get(apkUpdateStateAtom);
    if (state.status !== "ready" && state.status !== "installing") void updater.check();
  };
  const unsubscribe = appAtomRegistry.subscribe(
    mobilePreferencesAtom,
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const nextEnabled = result.value.apkAutoUpdateEnabled !== false;
      if (enabled === nextEnabled) return;
      enabled = nextEnabled;
      if (enabled) checkAutomatically();
      else updater.cancel();
    },
    { immediate: true },
  );
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "background") backgroundedAt = Date.now();
    if (state !== "active") return;
    void updater.foreground();
    if (enabled && backgroundedAt !== undefined && Date.now() - backgroundedAt >= 15 * 60 * 1000) {
      checkAutomatically();
    }
    backgroundedAt = undefined;
  });
  return () => {
    unsubscribe();
    subscription.remove();
    updater.cancel();
  };
}
