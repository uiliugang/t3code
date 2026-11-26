import { useState } from "react";
import { View } from "react-native";
import { FormSheet } from "react-native-screens";
import { useResolveClassNames } from "uniwind";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { AppBar } from "./AppBar";
import { AndroidHeaderIconButton } from "./AndroidScreenHeader.android";
import { BottomSheetContext } from "./BottomSheetContext";
import { OverlayPortalScope } from "./OverlayPortal";
import { RoutedFormSheetContext } from "./RoutedFormSheetContext";
import { ScreenContent } from "./ScreenContent";
import type { SheetProps } from "./Sheet.types";
export type { SheetProps } from "./Sheet.types";

export function Sheet(props: SheetProps) {
  const t = useUiTranslation();
  const containerStyle = useResolveClassNames("bg-header");
  const [isOpen, setIsOpen] = useState(true);
  return (
    <FormSheet
      isOpen={isOpen}
      detents={props.expanded ? [0.9] : [0.5, 0.9]}
      prefersGrabberVisible={false}
      preventNativeDismiss={props.dismissDisabled}
      nativeContainerStyle={containerStyle}
      onDismiss={props.onClose}
      onNativeDismiss={props.onClose}
    >
      <BottomSheetContext value>
        <RoutedFormSheetContext value={false}>
          {/* Android FormSheet does not bound flex children. */}
          <View collapsable={false} className="absolute inset-0 bg-header">
            <OverlayPortalScope>
              <AppBar
                sheet
                title={props.title}
                // Keep Compose's navigation slot mounted while dismissal is disabled.
                leading={
                  <AndroidHeaderIconButton
                    accessibilityLabel={t("Navigate up")}
                    icon="arrow.left"
                    disabled={props.dismissDisabled}
                    onPress={() => {
                      if (!props.dismissDisabled) setIsOpen(false);
                    }}
                  />
                }
                hideBottomBorder
              />
              <ScreenContent>{props.children}</ScreenContent>
              <View
                pointerEvents="none"
                className="absolute top-1 h-1 w-8 self-center rounded-full bg-header-foreground/40"
              />
            </OverlayPortalScope>
          </View>
        </RoutedFormSheetContext>
      </BottomSheetContext>
    </FormSheet>
  );
}
