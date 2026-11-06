import {
  assertSettingsFileSize,
  parseSettingsFile,
  serializeSettingsFile,
  type SettingsFile,
} from "@t3tools/client-runtime/settings-transfer";
import { File } from "expo-file-system";

import { shareGeneratedAttachment } from "../../lib/attachmentDownload";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";

export async function pickSettingsFile(): Promise<SettingsFile | null> {
  const { getDocumentAsync } = await import("expo-document-picker");
  const finishHandoff = beginForegroundHandoff();
  try {
    const result = await getDocumentAsync({
      type: ["application/json", "text/plain"],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;
    const file = new File(asset.uri);
    try {
      assertSettingsFileSize(asset.size ?? file.size);
      return parseSettingsFile(await file.text());
    } finally {
      file.delete();
    }
  } finally {
    finishHandoff();
  }
}

export async function shareSettingsFile(settings: SettingsFile): Promise<void> {
  const shared = await shareGeneratedAttachment({
    bytes: new TextEncoder().encode(serializeSettingsFile(settings)),
    attachment: {
      name: `t3-code-${settings.scope}-settings.json`,
      mimeType: "application/json",
    },
    signal: new AbortController().signal,
  });
  if (!shared) throw new Error("File sharing is unavailable on this device.");
}
