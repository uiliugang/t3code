type MobileStage = "dev" | "nightly";

export function resolveMobileStage(appVariant: unknown): MobileStage | null {
  if (appVariant === "development") return "dev";
  if (appVariant === "preview") return "nightly";
  return null;
}
