import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppActivityIndicator } from "./AppActivityIndicator";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { RowPressable } from "./RowPressable";

export function ListActionRow(
  props: ListRowContentProps & {
    readonly tone?: "default" | "danger";
    readonly loading?: boolean;
    readonly trailingIcon?: AppSymbolName;
    readonly onPress: () => void;
  },
) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  const disabled = Boolean(props.disabled || props.loading);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.description}
      accessibilityState={{ disabled, busy: Boolean(props.loading) }}
      disabled={disabled}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <ListRowLayout
        {...props}
        disabled={disabled}
        accessory={
          props.loading ? (
            <AppActivityIndicator
              colorClassName={props.tone === "danger" ? "accent-danger-foreground" : "accent-icon"}
            />
          ) : props.trailingIcon ? (
            <View className="size-6 items-center justify-center">
              <SymbolView
                name={props.trailingIcon}
                size={Platform.OS === "android" ? 24 : 22}
                tintColorClassName={
                  props.tone === "danger" ? "accent-danger-foreground" : "accent-icon"
                }
                type="monochrome"
                weight="regular"
              />
            </View>
          ) : undefined
        }
      />
    </RowPressable>
  );
}
