import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SOURCE_CONTROL_MEDIA_ASSET, type EnvironmentId } from "@t3tools/contracts";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";

export interface PullRequestMediaLocation {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly repository?: string;
  readonly directImages?: boolean;
  readonly bridgedImages?: boolean;
}

export function pullRequestMediaSource(
  url: string,
  location: PullRequestMediaLocation | null,
  kind: "image" | "video" | "unknown",
) {
  const fetchUrl = sourceControlClients.mediaUrl(url)?.fetchUrl;
  if (kind === "image" && location?.directImages && !location.bridgedImages && fetchUrl)
    return { uri: fetchUrl };
  return location && fetchUrl
    ? {
        environmentId: location.environmentId,
        resource: {
          _tag: SOURCE_CONTROL_MEDIA_ASSET,
          cwd: location.cwd,
          url: fetchUrl,
          ...(location.repository ? { repository: location.repository } : {}),
        },
      }
    : { uri: url };
}

export function pullRequestImageSource(
  url: string,
  location: PullRequestMediaLocation | null,
): FilePreviewItem {
  return { kind: "image", ...pullRequestMediaSource(url, location, "image") };
}
