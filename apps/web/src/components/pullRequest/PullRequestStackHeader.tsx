import { useUiTranslation } from "~/hooks/useUiTranslation";

import { MenuGroupLabel } from "../ui/menu";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function PullRequestStackHeader({
  number,
  notice,
  stale = false,
}: {
  number: number;
  notice?: string | null | undefined;
  stale?: boolean;
}) {
  const t = useUiTranslation();
  return (
    <MenuGroupLabel>
      <div className="flex items-center justify-between gap-2">
        <span>{t("Stack #{number}", { number })}</span>
        {notice ? (
          <SharedTooltipTrigger
            render={<span role="status" className="text-xs font-normal" />}
            label={<> {t(notice)} </>}
          >
            {stale ? t("May be stale") : t("Refreshing…")}
          </SharedTooltipTrigger>
        ) : null}
      </div>
    </MenuGroupLabel>
  );
}
