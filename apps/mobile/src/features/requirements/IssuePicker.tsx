import type { IssueOption } from "@t3tools/contracts";
import { Pressable } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { ComponentProps } from "react";

export function IssuePicker({
  label,
  value,
  options,
  onChange,
  disabled = false,
  icon,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<IssueOption>;
  onChange: (value: string) => void;
  disabled?: boolean;
  icon?: ComponentProps<typeof SymbolView>["name"];
}) {
  return (
    <Menu
      title={label}
      actions={options.map((option) => ({
        id: option.value,
        title: option.label,
        state: option.value === value ? "on" : "off",
        attributes: { disabled },
      }))}
      onPressAction={(event) => onChange(event.nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        className={
          icon
            ? "size-12 items-center justify-center"
            : "min-h-12 justify-center border-b border-border-subtle py-3"
        }
      >
        {icon ? (
          <SymbolView name={icon} size={22} tintColorClassName="accent-foreground" />
        ) : (
          <>
            <AppText className="text-xs text-foreground-muted">{label}</AppText>
            <AppText className="text-base text-foreground">
              {options.find((option) => option.value === value)?.label ?? label}
            </AppText>
          </>
        )}
      </Pressable>
    </Menu>
  );
}
