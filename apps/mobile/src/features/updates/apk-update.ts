import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const ApkUpdateManifest = Schema.Struct({
  packageName: Schema.NonEmptyString,
  versionCode: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2100000000 })),
  versionName: Schema.NonEmptyString,
  url: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/i)),
});
const decodeApkUpdateManifest = Schema.decodeUnknownOption(ApkUpdateManifest);

export type ApkUpdateManifest = typeof ApkUpdateManifest.Type;
type DownloadedUpdate = { readonly manifest: ApkUpdateManifest; readonly uri: string };

export type ApkUpdateState =
  | { readonly status: "idle" | "checking" | "current" }
  | { readonly status: "downloading"; readonly version: string }
  | { readonly status: "ready"; readonly version: string; readonly permissionRequired: boolean }
  | { readonly status: "installing"; readonly version: string }
  | { readonly status: "error"; readonly message: string };

export function requireHttpsUpdateUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("APK updates require an HTTPS URL without credentials.");
  }
  return url.href;
}

export function createApkUpdater(options: {
  readonly packageName: string;
  readonly versionCode: number;
  readonly fetchManifest: (signal: AbortSignal) => Promise<unknown>;
  readonly download: (manifest: ApkUpdateManifest, signal: AbortSignal) => Promise<string>;
  readonly install: (
    update: DownloadedUpdate,
    requestPermission: boolean,
  ) => Promise<"installing" | "permission-required">;
  readonly flushPendingWrites: () => Promise<void>;
  readonly isForeground: () => boolean;
  readonly onStateChange: (state: ApkUpdateState) => void;
}) {
  let pending: DownloadedUpdate | undefined;
  let inFlight: Promise<void> | undefined;
  let inFlightSignal: AbortSignal | undefined;
  let installation:
    | { readonly update: DownloadedUpdate; readonly promise: Promise<void> }
    | undefined;
  let cancellation = new AbortController();
  let resumeAfterPermission = false;
  let autoInstallPending = false;
  let permissionRequired = false;

  const fail = (error: unknown) => {
    options.onStateChange({
      status: "error",
      message: error instanceof Error ? error.message : "Could not update the app.",
    });
  };

  const install = (requestPermission = true): Promise<void> => {
    if (!pending || !options.isForeground()) return Promise.resolve();
    const update = pending;
    if (installation) {
      return installation.update === update
        ? installation.promise
        : installation.promise.then(() => install(requestPermission));
    }
    const promise = Promise.resolve().then(async () => {
      try {
        await options.flushPendingWrites();
        if (!options.isForeground() || pending !== update) return;
        autoInstallPending = false;
        const result = await options.install(update, requestPermission);
        if (pending !== update) return;
        permissionRequired = result === "permission-required";
        resumeAfterPermission = permissionRequired && requestPermission;
        options.onStateChange(
          result === "installing"
            ? { status: "installing", version: update.manifest.versionName }
            : { status: "ready", version: update.manifest.versionName, permissionRequired },
        );
      } catch (error) {
        if (pending !== update) return;
        pending = undefined;
        fail(error);
      } finally {
        installation = undefined;
      }
    });
    installation = { update, promise };
    return promise;
  };

  const check = (): Promise<void> => {
    const signal = cancellation.signal;
    if (inFlight) {
      return inFlightSignal?.aborted
        ? inFlight.then(() => (signal.aborted ? undefined : check()))
        : inFlight;
    }
    inFlightSignal = signal;
    // Publish the promise before callbacks can reenter the updater.
    inFlight = Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted();
        options.onStateChange({ status: "checking" });
        const decoded = decodeApkUpdateManifest(await options.fetchManifest(signal));
        signal.throwIfAborted();
        if (Option.isNone(decoded)) throw new Error("The APK update manifest is invalid.");
        const manifest = decoded.value;
        requireHttpsUpdateUrl(manifest.url);
        if (manifest.packageName !== options.packageName) {
          throw new Error("The update is for a different app.");
        }
        if (pending && pending.manifest.versionCode >= manifest.versionCode) {
          options.onStateChange({
            status: "ready",
            version: pending.manifest.versionName,
            permissionRequired,
          });
          await install(false);
          return;
        }
        if (manifest.versionCode <= options.versionCode) {
          options.onStateChange({ status: "current" });
          return;
        }
        pending = undefined;
        options.onStateChange({ status: "downloading", version: manifest.versionName });
        const uri = await options.download(manifest, signal);
        signal.throwIfAborted();
        pending = { manifest, uri };
        autoInstallPending = true;
        permissionRequired = false;
        options.onStateChange({
          status: "ready",
          version: manifest.versionName,
          permissionRequired: false,
        });
        await install();
      } catch (error) {
        if (!signal.aborted) fail(error);
      } finally {
        inFlight = undefined;
      }
    });
    return inFlight;
  };

  return {
    check,
    install,
    async foreground() {
      if (autoInstallPending) {
        await install();
      } else if (resumeAfterPermission) {
        resumeAfterPermission = false;
        await install(false);
      } else if (pending) {
        options.onStateChange({
          status: "ready",
          version: pending.manifest.versionName,
          permissionRequired,
        });
      }
    },
    cancel() {
      cancellation.abort();
      cancellation = new AbortController();
      pending = undefined;
      resumeAfterPermission = false;
      autoInstallPending = false;
      options.onStateChange({ status: "idle" });
    },
  };
}
