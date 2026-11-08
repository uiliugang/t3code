import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

export type BrowserMicrophone = Pick<MediaDeviceInfo, "deviceId" | "label">;

export async function listBrowserMicrophones(
  t: UiTranslator = translateUi.bind(null, "en"),
): Promise<BrowserMicrophone[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map(({ deviceId, label }, index) => ({
      deviceId,
      label: label || t("Microphone {number}", { number: index + 1 }),
    }));
}
