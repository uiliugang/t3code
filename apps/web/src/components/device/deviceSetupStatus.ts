import type { DevicePlatform, DeviceServiceState } from "@t3tools/contracts";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

const platformName = (platform: DevicePlatform) => (platform === "ios" ? "iOS" : "Android");

/** Platforms whose latest listing on a ready host may be missing devices. */
export const incompleteListings = (
  status: DeviceServiceState["hostStatuses"][string] | undefined,
) =>
  (["ios", "android"] as const).filter(
    (platform) =>
      status?.status === "ready" &&
      (status.incompletePlatforms?.includes(platform) ||
        (platform === "android" && status.androidDiscoveryIncomplete === true)),
  );

export const isAndroidDiscoveryUncertain = (state: DeviceServiceState) =>
  Object.values(state.hostStatuses).some((status) =>
    incompleteListings(status).includes("android"),
  );

/**
 * `hostStatus` only tracks this machine. A machine without simulator tooling never
 * starts its own hub, so setup and the panel must also count remote device hosts.
 */
export function deviceHubReadiness(state: DeviceServiceState) {
  const statuses = Object.values(state.hostStatuses).map((host) => host.status);
  const ready = state.hostStatus === "ready" || statuses.includes("ready");
  const busy =
    !ready &&
    [state.hostStatus, ...statuses].some(
      (status) => status === "installing" || status === "starting",
    );
  return { ready, busy };
}

export function platformSetupStatus(
  state: DeviceServiceState,
  platform: DevicePlatform,
  t: UiTranslator = (message, values) => translateUi("en", message, values),
) {
  const hasDevices = state.devices.some((device) => device.platform === platform);
  if (platform === "android" && !hasDevices && isAndroidDiscoveryUncertain(state)) {
    return {
      ready: false,
      message: t("The Android device list may be incomplete. Check the device host and try again."),
    };
  }
  const availabilities = state.hosts.flatMap((host) =>
    host.platforms
      .filter((candidate) => candidate.platform === platform)
      .map((candidate) => ({ ...candidate, host })),
  );
  const supportingHosts = availabilities
    .filter((candidate) => candidate.available)
    .map((candidate) => candidate.host);
  if (supportingHosts.length === 0) {
    return {
      ready: false,
      message:
        availabilities[0]?.reason ??
        t("{platform} support was not detected.", { platform: platformName(platform) }),
    };
  }
  const readyHosts = supportingHosts.filter(
    (host) =>
      state.hostStatuses[host.id]?.status === "ready" ||
      (host.kind === "local" && state.hostStatus === "ready"),
  );
  if (readyHosts.length > 0 && !hasDevices) {
    if (
      readyHosts.some((host) =>
        state.hostStatuses[host.id]?.incompletePlatforms?.includes(platform),
      )
    ) {
      return {
        ready: false,
        message: t(
          "No {platform} devices were listed because device discovery reported a problem.",
          { platform: platformName(platform) },
        ),
      };
    }
    return {
      ready: false,
      message:
        platform === "ios"
          ? t(
              "Xcode is installed, but no iOS Simulator is available. Install a runtime in Xcode Settings → Components.",
            )
          : t(
              "The Android SDK is installed, but no virtual device exists. Create one in Android Studio → Device Manager.",
            ),
    };
  }
  const remoteHost = supportingHosts.every((host) => host.kind !== "local")
    ? supportingHosts[0]
    : undefined;
  return {
    ready: true,
    message:
      remoteHost?.kind === "eas"
        ? t("{host} starts {platform} in the cloud with Expo Simulators.", {
            host: remoteHost.label,
            platform: platform === "ios" ? t("iOS Simulators") : t("Android emulators"),
          })
        : platform === "ios"
          ? remoteHost
            ? t("Xcode and iOS Simulator are available on {host}.", { host: remoteHost.label })
            : t("Xcode and iOS Simulator are available.")
          : remoteHost
            ? t("The Android SDK and Emulator are available on {host}.", {
                host: remoteHost.label,
              })
            : t("The Android SDK and Emulator are available."),
  };
}
