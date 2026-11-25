import * as Dialog from "../../components/ui/Dialog";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { m } from "../../i18n/messages";
import { useEffect, useRef } from "react";

import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { refreshAssetUrl } from "../../state/assets";
import { fileChipShareSource, type FileChipTarget } from "./fileChipMenu";

export function useFileChipShare(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sourceIdentifier: string,
  noise: boolean,
) {
  const gt = useGT();
  const requestRef = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the in-flight file share download when the component unmounts
  useEffect(() => () => requestRef.current?.abort(), []);

  return (target: FileChipTarget) => {
    const source = fileChipShareSource(target, threadId, noise);
    if (!source || requestRef.current) return;
    const request = new AbortController();
    requestRef.current = request;
    let releaseFile: (() => void) | undefined;
    void (async () => {
      const url = await refreshAssetUrl(
        environmentId,
        source.resource,
        request.signal,
        (release) => {
          releaseFile = release;
        },
      );
      if (request.signal.aborted) return;
      if (url === null)
        throw new Error(gt("The file could not be loaded. Reconnect and try again."));
      await downloadAndShareAttachment({
        url,
        attachment: source,
        signal: request.signal,
        sourceIdentifier,
      });
    })()
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Dialog.alert(
            gt("Could not share file"),
            errorDisplayMessage(error, m) ?? gt("Try again."),
          );
        }
      })
      .finally(() => {
        releaseFile?.();
        if (requestRef.current === request) {
          requestRef.current = null;
        }
      });
  };
}
