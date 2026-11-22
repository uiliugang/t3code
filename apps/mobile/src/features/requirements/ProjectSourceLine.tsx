import { createContext, use, useCallback, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { AppText } from "../../components/ui/AppText";

const actionWidth = 72;
type SwipeChange = (close: () => void, open: boolean) => void;
export const ProjectSourceSwipeChange = createContext<SwipeChange | null>(null);

export function useProjectSourceSwipes() {
  const active = useRef<(() => void) | null>(null);
  const onChange: SwipeChange = (close, open) => {
    if (open && active.current !== close) {
      active.current?.();
      active.current = close;
    } else if (!open && active.current === close) {
      active.current = null;
    }
  };
  return { onChange, close: () => active.current?.() };
}

export function ProjectSourceLine({
  value,
  label,
  detail,
  action,
  actionLabel,
  onEdit,
}: {
  value: string;
  label?: string;
  detail: string | undefined;
  action: string;
  actionLabel: string;
  onEdit: (() => void) | undefined;
}) {
  const row = (
    <View
      accessible
      accessibilityActions={onEdit ? [{ name: "editSource", label: actionLabel }] : undefined}
      onAccessibilityAction={
        onEdit
          ? ({ nativeEvent }) => {
              if (nativeEvent.actionName === "editSource") onEdit();
            }
          : undefined
      }
      onAccessibilityTap={onEdit}
      className="min-h-12 flex-row items-center gap-3 bg-grouped-card py-1"
    >
      {label ? (
        <AppText textRole="label" className="shrink font-t3-medium text-foreground-muted">
          {label}
        </AppText>
      ) : null}
      <View className="min-w-0 flex-1">
        <AppText textRole="body">{value}</AppText>
        {detail ? (
          <AppText textRole="label" className="text-foreground-muted">
            {detail}
          </AppText>
        ) : null}
      </View>
    </View>
  );
  if (!onEdit) return row;
  return (
    <SourceSwipeAction action={action} actionLabel={actionLabel} onEdit={onEdit}>
      {row}
    </SourceSwipeAction>
  );
}

function SourceSwipeAction({
  action,
  actionLabel,
  onEdit,
  children,
}: {
  action: string;
  actionLabel: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  const onChange = use(ProjectSourceSwipeChange);
  const swipeable = useRef<SwipeableMethods>(null);
  const close = useCallback(() => swipeable.current?.close(), []);
  const [revealed, setRevealed] = useState(false);
  return (
    <Swipeable
      ref={swipeable}
      rightThreshold={32}
      overshootRight={false}
      childrenContainerStyle={revealed ? { paddingLeft: actionWidth } : undefined}
      failOffsetY={[-12, 12]}
      enableTrackpadTwoFingerGesture
      onSwipeableWillOpen={() => {
        onChange?.(close, true);
        setRevealed(true);
      }}
      onSwipeableWillClose={() => {
        onChange?.(close, false);
        setRevealed(false);
      }}
      renderRightActions={() => (
        <View className="justify-center rounded-xl bg-primary" style={{ width: actionWidth }}>
          {revealed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={actionLabel}
              onPress={onEdit}
              className="min-h-12 flex-1 items-center justify-center px-2 active:opacity-70"
            >
              <AppText textRole="footnote" className="font-t3-medium text-primary-foreground">
                {action}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      )}
    >
      {children}
    </Swipeable>
  );
}
