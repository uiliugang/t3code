import type { DeviceMediaTransport } from "@t3tools/client-runtime/device/hub-access";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { toastManager } from "~/components/ui/toast";

export async function savePreviewDownload(
  url: string,
  fileName: string,
  transport?: DeviceMediaTransport,
) {
  let objectUrl: string | undefined;
  try {
    if (transport) {
      const response = await transport.fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      // The downloaded page may control the MIME type. The browser only needs a file to save.
      objectUrl = URL.createObjectURL(
        (await response.blob()).slice(0, undefined, "application/octet-stream"),
      );
    }
    const anchor = document.createElement("a");
    anchor.href = objectUrl ?? url;
    anchor.download = fileName;
    anchor.click();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: m(msg("An error occurred.")),
      description: error instanceof Error ? error.message : undefined,
    });
  } finally {
    if (objectUrl) {
      const released = objectUrl;
      setTimeout(() => URL.revokeObjectURL(released), 1000);
    }
  }
}
