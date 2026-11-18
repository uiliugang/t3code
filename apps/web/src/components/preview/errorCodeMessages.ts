import { PREVIEW_ERROR_CODE_MESSAGES } from "./previewConstants";

export function describePreviewError(description: string, t: (message: string) => string): string {
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (friendly) return t(friendly);
  if (description.length > 0) return description;
  return t("Network error");
}
