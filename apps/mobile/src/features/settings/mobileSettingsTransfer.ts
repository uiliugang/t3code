import {
  assertSettingsFileSize,
  parseSettingsFile,
  serializeSettingsFile,
  type SettingsFile,
} from "@t3tools/client-runtime/settings-transfer";
import { Directory, File, Paths } from "expo-file-system";

import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { uuidv4 } from "../../lib/uuid";

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
  const sharing = await import("expo-sharing");
  if (!(await sharing.isAvailableAsync()))
    throw new Error("File sharing is unavailable on this device.");
  const contents = serializeSettingsFile(settings);
  const directory = new Directory(Paths.cache, `settings-export-${uuidv4()}`);
  directory.create();
  const file = new File(directory, `t3-code-${settings.scope}-settings.json`);
  const finishHandoff = beginForegroundHandoff();
  try {
    file.write(contents);
    await sharing.shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json" });
  } finally {
    finishHandoff();
    directory.delete();
  }
}
