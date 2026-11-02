import { useAtomValue } from "@effect/atom-react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

import { shortcutLabelForCommand } from "../keybindings";
import {
  navigateHistory,
  useCanNavigateHistory,
  type HistoryDirection,
} from "../navigationHistory";
import { primaryServerKeybindingsAtom } from "../state/server";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function NavigationHistoryControls() {
  if (typeof window === "undefined" || !window.navigation) return null;

  return (
    <div className="hidden shrink-0 items-center @lg/thread-header:flex">
      <HistoryNavigationButton direction="back" />
      <HistoryNavigationButton direction="forward" />
    </div>
  );
}

function HistoryNavigationButton({ direction }: { direction: HistoryDirection }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const enabled = useCanNavigateHistory(direction);
  const label = direction === "back" ? "Go back" : "Go forward";
  const shortcutLabel = shortcutLabelForCommand(
    keybindings,
    direction === "back" ? "navigation.back" : "navigation.forward",
  );
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="[-webkit-app-region:no-drag]"
            disabled={!enabled}
            onClick={() => navigateHistory(direction)}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
