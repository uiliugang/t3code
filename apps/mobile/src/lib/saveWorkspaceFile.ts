import { Directory, File, FileMode } from "expo-file-system";
import { beginForegroundHandoff } from "./foreground-handoff";

export async function saveWorkspaceFile(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly signal: AbortSignal;
  readonly resolveUri: () => Promise<string | null>;
}): Promise<boolean> {
  const { signal } = input;
  if (signal.aborted) return false;
  const endHandoff = beginForegroundHandoff();
  let directory: Directory;
  try {
    directory = await Directory.pickDirectoryAsync();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_PICKER_CANCELLED"
    ) {
      return false;
    }
    throw error;
  } finally {
    endHandoff();
  }
  if (signal.aborted) return false;
  const uri = await input.resolveUri();
  if (signal.aborted || uri === null) return false;
  if (!uri.startsWith("file://")) throw new Error("The local file is unavailable.");
  const source = new File(uri);
  const size = source.size;
  const reader = source.open(FileMode.ReadOnly);
  try {
    // SAF creates a fresh document even when another file has the same display name.
    const destination = directory.createFile(input.name, input.mimeType);
    let complete = false;
    try {
      const writer = destination.open(FileMode.WriteOnly);
      try {
        let copied = 0;
        while (copied < size && !signal.aborted) {
          const part = await reader.readBytes(Math.min(size - copied, 256 * 1024));
          if (part.byteLength === 0) throw new Error("The local file is unavailable.");
          if (signal.aborted) return false;
          await writer.writeBytes(part);
          copied += part.byteLength;
        }
      } finally {
        writer.close();
      }
      complete = !signal.aborted;
      return complete;
    } finally {
      if (!complete && destination.exists) destination.delete();
    }
  } finally {
    reader.close();
  }
}
