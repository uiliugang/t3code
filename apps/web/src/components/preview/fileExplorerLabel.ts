import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

type Translate = (message: string) => string;
const identity: Translate = (message) => message;

export function revealInFileExplorerLabel(platform: string, t: Translate = identity): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return t("Reveal in Finder");
  if (normalized.includes("win")) return t("Reveal in File Explorer");
  return t("Reveal in Files");
}

export function revealInFileExplorerLabelForOs(
  os: ExecutionEnvironmentPlatformOs,
  t: Translate = identity,
): string {
  if (os === "darwin") return t("Reveal in Finder");
  if (os === "windows") return t("Reveal in File Explorer");
  return t("Reveal in Files");
}

export function revealInFileExplorerLabelForKind(
  kind: FileManagerRevealKind,
  t: Translate = identity,
): string {
  if (kind === "finder") return t("Reveal in Finder");
  if (kind === "file-explorer") return t("Reveal in File Explorer");
  return t("Reveal in Files");
}
