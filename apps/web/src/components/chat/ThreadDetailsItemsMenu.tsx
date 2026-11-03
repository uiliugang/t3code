import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";
import { useUiTranslation } from "../../hooks/useUiTranslation";

/** Menu body that shows and hides thread details items. The card's context menu and Settings share it. */
export function ThreadDetailsItemsMenuItems() {
  const t = useUiTranslation();
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const separate = useClientSettings((settings) => settings.branchIssuesPlacement === "separate");
  const expanded = useClientSettings((settings) => settings.branchIssuesExpanded);
  const showEmpty = useClientSettings((settings) => settings.branchIssuesShowEmpty);
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Show in thread details</MenuGroupLabel>
        {THREAD_DETAILS_ITEMS.map((item) => (
          <MenuCheckboxItem
            key={item.id}
            checked={visibility[item.id]}
            onCheckedChange={(checked) =>
              updateClientSettings({
                threadDetailsItems: setThreadDetailsItem(getClientSettings(), item, checked),
              })
            }
          >
            {t(item.label)}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>{t("Linked issues")}</MenuGroupLabel>
        <MenuCheckboxItem
          checked={separate}
          onCheckedChange={(checked) =>
            updateClientSettings({ branchIssuesPlacement: checked ? "separate" : "inline" })
          }
        >
          {t("Separate card")}
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={expanded}
          onCheckedChange={(checked) => updateClientSettings({ branchIssuesExpanded: checked })}
        >
          {t("Expand issue descriptions by default")}
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={showEmpty}
          onCheckedChange={(checked) => updateClientSettings({ branchIssuesShowEmpty: checked })}
        >
          {t("Show when no issues are linked")}
        </MenuCheckboxItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        disabled={
          isDefaultThreadDetailsVisibility(visibility) && !separate && !expanded && showEmpty
        }
        onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
      >
        Reset to default
      </MenuItem>
    </>
  );
}
