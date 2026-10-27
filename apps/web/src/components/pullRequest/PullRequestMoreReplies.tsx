import { useUiTranslation } from "~/hooks/useUiTranslation";
import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
}: PullRequestReplyAvailability) {
  const t = useUiTranslation();
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {moreReplies > 0
          ? t(moreReplies === 1 ? "{count} more reply" : "{count} more replies", {
              count: moreReplies.toLocaleString(),
            })
          : t("More replies")}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
        >
          {t("View on host")}
        </a>
      ) : null}
    </div>
  );
}
