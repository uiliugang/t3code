import { FilterIcon } from "lucide-react";

import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useDiffFileFilters } from "./useDiffFileFilters";

export function DiffFileFilterMenu({
  filters,
}: {
  filters: ReturnType<typeof useDiffFileFilters>;
}) {
  const t = useUiTranslation();
  const active = filters.hideTestFiles || filters.hideMarkdownFiles;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant={active ? "secondary" : "ghost"}
                  aria-label={t("Filter files")}
                  aria-pressed={active}
                />
              }
            />
          }
        >
          <FilterIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{t("Filter files")}</TooltipPopup>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={filters.hideTestFiles}
          onCheckedChange={(checked) => filters.setHideTestFiles(Boolean(checked))}
          closeOnClick={false}
        >
          {t("Hide test files")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filters.hideMarkdownFiles}
          onCheckedChange={(checked) => filters.setHideMarkdownFiles(Boolean(checked))}
          closeOnClick={false}
        >
          {t("Hide .md files")}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
