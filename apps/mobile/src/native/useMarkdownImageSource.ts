import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { useEnvironmentPresentation } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { resolveMobileMarkdownMediaSource } from "../lib/markdownMediaSource";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { MarkdownImageSourceResolver } from "./SelectableMarkdownText.types";
import { normalizeNativeMarkdownUrl } from "../lib/markdownLinks";
import { useCallback, useEffect, useRef } from "react";
import * as Option from "effect/Option";

import { m } from "../i18n/messages";
import { refreshAssetUrl } from "../state/assets";
import { environmentSession, usePreparedConnection } from "../state/session";

export function useMarkdownImageSource(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly workspaceRoot: string | null;
  readonly captured?: boolean;
  readonly blockRemoteEmbeds?: boolean;
  readonly draftWorkspaceRoot?: string;
}): MarkdownImageSourceResolver {
  const {
    environmentId,
    threadId,
    workspaceRoot,
    captured,
    blockRemoteEmbeds,
    draftWorkspaceRoot,
  } = props;
  const connection = usePreparedConnection(environmentId);
  const environment = useEnvironmentPresentation(environmentId);
  const connectionPhase = environment.presentation?.connection.phase;
  const session = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: environment.isReady,
      connection: environment.presentation?.connection ?? null,
      session: session.data,
      sessionError: session.error,
    },
    m,
  );
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const noise = connection._tag === "Some" && connection.value.transport === "noise";
  const sourceOnlyMedia = noise && !connection.value.mediaOrigins;
  const owner = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native text view retains resolved image URIs until it unmounts or changes workspace
  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- changing the document or transport releases its cached images
  }, [environmentId, threadId, workspaceRoot, noise]);
  return useCallback(
    async (image) => {
      const media = resolveMobileMarkdownMediaSource(image.href, {
        threadId: threadId ?? undefined,
        workspaceRoot,
        draftWorkspaceRoot,
        imageEmbed: true,
      });
      if (media?.access === "direct") {
        if (blockRemoteEmbeds) throw new Error("Remote image is unavailable");
        return { uri: normalizeNativeMarkdownUrl(media.uri) };
      }
      if (
        captured ||
        !fileAccess.canReadFiles ||
        media === null ||
        media.access === "unavailable" ||
        httpBaseUrl === null ||
        (sourceOnlyMedia && media.mimeType === "image/svg+xml") ||
        connectionPhase === "offline" ||
        connectionPhase === "error" ||
        connectionPhase === "unsupported" ||
        connectionPhase === "reconnecting"
      )
        throw new Error("Markdown image is unavailable");
      const signal = owner.current?.signal;
      if (!signal || signal.aborted) throw new Error("Markdown image is unavailable");
      const uri = await refreshAssetUrl(environmentId, media.resource, signal, (release) => {
        if (signal.aborted) release();
        else signal.addEventListener("abort", release, { once: true });
      });
      if (uri === null || signal.aborted) throw new Error("Could not authorize Markdown image");
      return { uri };
    },
    [
      captured,
      fileAccess.canReadFiles,
      connectionPhase,
      blockRemoteEmbeds,
      draftWorkspaceRoot,
      sourceOnlyMedia,
      environmentId,
      httpBaseUrl,
      threadId,
      workspaceRoot,
    ],
  );
}
