import { useUiTranslation } from "../../hooks/useUiTranslation";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { useSettingsScope } from "./SettingsScopeContext";
import { ALL_PROJECTS_VALUE, selectProjectAxis } from "./settingsScopeAxis";

export function ProjectTypeFilterControl() {
  const t = useUiTranslation();
  const { projectTypeFilter, setProjectTypeFilter, search, selectScope } = useSettingsScope();
  return (
    <ToggleGroup
      aria-label={t("Filter projects by type")}
      size="sm"
      value={[projectTypeFilter]}
      onValueChange={(values) => {
        const filter = values[0];
        if (filter === "all" || filter === "repo" || filter === "group") {
          setProjectTypeFilter(filter);
          if (search.project) selectScope(selectProjectAxis(search, ALL_PROJECTS_VALUE));
        }
      }}
    >
      <ToggleGroupItem value="all">{t("All")}</ToggleGroupItem>
      <ToggleGroupItem value="repo">{t("Projects")}</ToggleGroupItem>
      <ToggleGroupItem value="group">{t("Groups")}</ToggleGroupItem>
    </ToggleGroup>
  );
}
