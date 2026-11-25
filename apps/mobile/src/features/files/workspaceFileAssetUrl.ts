import type { WorkspaceFileResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import {
  isAbsolutePath,
  isAudioPreviewFile,
  isVideoPreviewFile,
  resolveWorkspaceFilePath,
} from "./filePath";

export function useWorkspaceFileAssetUrlState(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
  readonly revision?: string | undefined;
  readonly download?: boolean;
  readonly draftCwd?: string | null;
}) {
  const absolutePath =
    props.cwd !== null && props.relativePath !== null
      ? resolveWorkspaceFilePath(props.cwd, props.relativePath)
      : null;

  const relativePath = props.relativePath;
  const draftCwd = props.draftCwd ?? null;
  const resource = useMemo<WorkspaceFileResource | null>(() => {
    if (absolutePath === null || relativePath === null) return null;
    if (props.threadId !== null) {
      if (props.download)
        return {
          _tag: "media-file",
          threadId: props.threadId,
          path: absolutePath,
          disposition: "attachment",
        };
      return {
        _tag:
          isVideoPreviewFile(absolutePath) ||
          isAudioPreviewFile(absolutePath) ||
          isAbsolutePath(relativePath)
            ? "media-file"
            : "workspace-file",
        threadId: props.threadId,
        path: absolutePath,
      };
    }
    if (draftCwd === null) return null;
    return {
      _tag: "draft-workspace-file",
      cwd: draftCwd,
      path: relativePath,
      ...(props.download ? { disposition: "attachment" as const } : {}),
    };
  }, [absolutePath, relativePath, props.threadId, draftCwd, props.download]);
  const state = useAssetUrlState(props.environmentId, resource, props.revision);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  return { ...state, resource, refresh };
}
