import { ChevronDownIcon } from "lucide-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { ThreadDetailsItemsMenuItems } from "../chat/ThreadDetailsItemsMenu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  THREAD_DETAILS_ITEMS,
} from "../chat/threadDetailsItems";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useUiTranslation } from "../../hooks/useUiTranslation";

export function ThreadDetailsItemsRow() {
  const t = useUiTranslation();
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const issuesDefault = useClientSettings(
    (settings) =>
      settings.branchIssuesPlacement === "inline" &&
      !settings.branchIssuesExpanded &&
      settings.branchIssuesShowEmpty,
  );
  const enabled = THREAD_DETAILS_ITEMS.filter((item) => visibility[item.id]).length;
  return (
    <SettingsRow
      {...searchableSetting("thread-details-items")}
      description="Choose what the thread details card shows. You can also right-click the card."
      resetAction={
        isDefaultThreadDetailsVisibility(visibility) && issuesDefault ? null : (
          <SettingResetButton
            label="thread details"
            onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
          />
        )
      }
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between sm:w-40"
                aria-label={t("Thread details: {enabled} of {total} on", {
                  enabled,
                  total: THREAD_DETAILS_ITEMS.length,
                })}
              />
            }
          >
            {t("{enabled} of {total} on", { enabled, total: THREAD_DETAILS_ITEMS.length })}
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <ThreadDetailsItemsMenuItems />
          </MenuPopup>
        </Menu>
      }
    />
  );
}
