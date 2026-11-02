import { useUiTranslation } from "../../hooks/useUiTranslation";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { useSettingsScope } from "./SettingsScopeContext";

export function ProjectTypeFilterControl() {
  const t = useUiTranslation();
  const { projectTypeFilter, setProjectTypeFilter } = useSettingsScope();
  return (
    <ToggleGroup
      aria-label={t("Filter projects by type")}
      size="sm"
      value={[projectTypeFilter]}
      onValueChange={(values) => {
        const filter = values[0];
        if (filter === "all" || filter === "repo" || filter === "group")
          setProjectTypeFilter(filter);
      }}
    >
      <ToggleGroupItem value="all">{t("All")}</ToggleGroupItem>
      <ToggleGroupItem value="repo">{t("Projects")}</ToggleGroupItem>
      <ToggleGroupItem value="group">{t("Groups")}</ToggleGroupItem>
    </ToggleGroup>
  );
}
