import { useClientSettings } from "../../hooks/useSettings";
import { formatProjectDisplayName } from "@t3tools/shared/projectPresentation";

export function DraftProjectName({
  value,
  singleLine = false,
}: {
  value: string;
  singleLine?: boolean;
}) {
  const capitalize = useClientSettings((settings) => settings.capitalizeProjectNames);
  return (
    <span
      aria-label={value}
      className={`min-w-0 ${singleLine ? "block truncate text-left" : "line-clamp-2 whitespace-normal [overflow-wrap:anywhere]"}`}
    >
      {formatProjectDisplayName(value, capitalize)}
    </span>
  );
}
