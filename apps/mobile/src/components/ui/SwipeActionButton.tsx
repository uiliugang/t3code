import type { MenuAction } from "@react-native-menu/menu";
import type { ComponentProps } from "react";
import { Platform, Pressable, View, useWindowDimensions } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { Menu } from "./Menu";

export const SWIPE_ACTION_ITEM_WIDTH = 58;
const ACTION_CIRCLE_SIZE = 36;
const ACTION_ICON_SIZE = 15;
const COMPACT_ACTION_CIRCLE_SIZE = 28;
const COMPACT_ACTION_ICON_SIZE = 13;
// Match the provider header's size-8 circle with mobile's 14px rem.
const ICON_ONLY_ACTION_CIRCLE_SIZE = 28;
const ICON_ONLY_ACTION_ICON_SIZE = 18;
// At the default app text size, "Unarchive", the longest label, fills its slot at about 1.12x.
const ACTION_LABEL_MAX_FONT_SCALE = 1.1;
const ACTION_LABEL_MIN_HEIGHT = 14;
const ACTION_LABEL_OFFSET = 2;

export function fullSwipeActionStackHeight(labelLineHeight: number, fontScale: number) {
  const labelHeight = labelLineHeight * Math.min(fontScale, ACTION_LABEL_MAX_FONT_SCALE);
  // The offset shifts the label after centering, so it needs room on both sides.
  return (
    ACTION_CIRCLE_SIZE + ACTION_LABEL_OFFSET * 2 + Math.max(ACTION_LABEL_MIN_HEIGHT, labelHeight)
  );
}

export function SwipeActionButton(props: {
  readonly accessibilityLabel: string;
  readonly actionsWidth: number;
  readonly tone: "primary" | "secondary" | "danger";
  readonly compact: boolean;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold?: number;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label?: string;
  readonly disabled?: boolean;
  readonly menu?: {
    readonly actions: MenuAction[];
    readonly onPressAction: NonNullable<ComponentProps<typeof Menu>["onPressAction"]>;
    readonly title?: string;
  };
  readonly onPress: () => void;
  readonly rowHeight: number;
  readonly slidesUnderStretch?: boolean;
  readonly stretchesOnFullSwipe?: boolean;
  readonly translation: SharedValue<number>;
}) {
  const {
    actionsWidth,
    entryRange: [entryRangeStart, entryRangeEnd],
    slidesUnderStretch,
    stretchesOnFullSwipe,
    translation,
  } = props;
  const fullSwipeThreshold = props.fullSwipeThreshold ?? actionsWidth + SWIPE_ACTION_ITEM_WIDTH;
  const circleSize = !props.label
    ? ICON_ONLY_ACTION_CIRCLE_SIZE
    : props.compact
      ? COMPACT_ACTION_CIRCLE_SIZE
      : ACTION_CIRCLE_SIZE;
  const iconSize = !props.label
    ? ICON_ONLY_ACTION_ICON_SIZE
    : props.compact
      ? COMPACT_ACTION_ICON_SIZE
      : ACTION_ICON_SIZE;
  const { fontScale } = useWindowDimensions();
  // Even compact actions can outgrow a short row at large app text sizes; shrink the label's
  // leading to the room left under the circle.
  const labelRoom =
    props.compact && props.rowHeight > 0
      ? (props.rowHeight - circleSize) / Math.min(fontScale, ACTION_LABEL_MAX_FONT_SCALE)
      : Infinity;
  const labelLineHeight = Math.min(useScaledTextRole("micro").lineHeight, labelRoom);
  // Android scales lineHeight by the full font scale, past maxFontSizeMultiplier.
  const labelTextStyle = {
    lineHeight:
      Platform.OS === "android" && fontScale > ACTION_LABEL_MAX_FONT_SCALE
        ? (labelLineHeight * ACTION_LABEL_MAX_FONT_SCALE) / fontScale
        : labelLineHeight,
  };
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const entryProgress = interpolate(
      reveal,
      [entryRangeStart, entryRangeEnd],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const stretch = Math.max(reveal - actionsWidth, 0);
    const fullSwipeProgress = interpolate(
      reveal,
      [actionsWidth, fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity: stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            interpolate(entryProgress, [0, 1], [22, 0]) - (stretchesOnFullSwipe ? 0 : stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    };
  });
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const stretch = stretchesOnFullSwipe ? Math.max(reveal - actionsWidth, 0) : 0;

    return {
      transform: [{ translateX: -stretch }],
      width: circleSize + stretch,
    };
  });
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const stretch = stretchesOnFullSwipe ? Math.max(reveal - actionsWidth, 0) : 0;
    const armedProgress = interpolate(
      reveal,
      [fullSwipeThreshold, fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX: -stretch * (0.5 + armedProgress * 0.5) }],
    };
  });
  const labelStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const stretch = Math.max(reveal - actionsWidth, 0);
    if (!stretchesOnFullSwipe) {
      return {
        opacity: slidesUnderStretch
          ? interpolate(
              stretch,
              [0, SWIPE_ACTION_ITEM_WIDTH - circleSize],
              [1, 0],
              Extrapolation.CLAMP,
            )
          : 1,
      };
    }

    return {
      opacity: interpolate(
        reveal,
        [fullSwipeThreshold - 24, fullSwipeThreshold],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateX: -stretch * 0.5 }],
    };
  });

  const button = (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.menu === undefined ? props.onPress : undefined}
      style={({ pressed }) => ({
        alignItems: "center",
        height: "100%",
        justifyContent: "center",
        opacity: props.disabled ? 0.4 : pressed ? 0.72 : 1,
        width: "100%",
      })}
    >
      <View style={{ height: circleSize, width: circleSize }}>
        <Animated.View
          className={
            props.tone === "danger"
              ? "bg-danger"
              : props.tone === "secondary"
                ? "bg-secondary"
                : "bg-primary"
          }
          style={[
            {
              borderRadius: 999,
              height: circleSize,
              left: 0,
              position: "absolute",
              top: 0,
            },
            circleStyle,
          ]}
        />
        <Animated.View
          style={[
            {
              alignItems: "center",
              height: circleSize,
              justifyContent: "center",
              left: 0,
              position: "absolute",
              top: 0,
              width: circleSize,
            },
            iconStyle,
          ]}
        >
          <SymbolView
            name={props.icon}
            size={iconSize}
            tintColorClassName={
              props.tone === "danger"
                ? "accent-danger-foreground"
                : props.tone === "secondary"
                  ? "accent-secondary-foreground"
                  : "accent-primary-foreground"
            }
            type="monochrome"
          />
        </Animated.View>
      </View>
      {props.label ? (
        <Animated.View
          style={[
            {
              justifyContent: "center",
              minHeight: ACTION_LABEL_MIN_HEIGHT,
              // Offset without growing the box or moving the circle at 1x.
              top: props.compact ? 0 : ACTION_LABEL_OFFSET,
            },
            labelStyle,
          ]}
        >
          <Text
            className="text-3xs font-t3-medium text-foreground-muted"
            maxFontSizeMultiplier={ACTION_LABEL_MAX_FONT_SCALE}
            numberOfLines={1}
            style={labelTextStyle}
          >
            {props.label}
          </Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          width: SWIPE_ACTION_ITEM_WIDTH,
          zIndex: props.stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      {props.menu === undefined ? (
        button
      ) : (
        <Menu
          actions={props.menu.actions}
          onPressAction={props.menu.onPressAction}
          title={props.menu.title}
          style={{ height: "100%", width: "100%" }}
        >
          {button}
        </Menu>
      )}
    </Animated.View>
  );
}
