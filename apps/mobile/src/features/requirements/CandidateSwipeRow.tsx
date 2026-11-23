import type { WorkItemCandidate } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { AppText as Text } from "../../components/ui/AppText";
import { SWIPE_ACTION_ITEM_WIDTH, SwipeActionButton } from "../../components/ui/SwipeActionButton";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { EnvironmentTag } from "./RequirementPrimitives";

const ACTIONS_WIDTH = SWIPE_ACTION_ITEM_WIDTH * 2;
const IGNORE_REVEAL = [SWIPE_ACTION_ITEM_WIDTH * 0.55, ACTIONS_WIDTH * 0.85] as const;
const CREATE_REVEAL = [8, SWIPE_ACTION_ITEM_WIDTH * 0.72] as const;
const FAIL_OFFSET_Y: [number, number] = [-10, 10];

export function CandidateSwipeRow({
  candidate,
  environmentLabel,
  canCreate,
  canIgnore,
  onCreate,
  onIgnore,
  onWillOpen,
  onClose,
}: {
  readonly candidate: WorkItemCandidate;
  readonly environmentLabel: string;
  readonly canCreate: boolean;
  readonly canIgnore: boolean;
  readonly onCreate: () => void;
  readonly onIgnore: () => void;
  readonly onWillOpen: (row: SwipeableMethods) => void;
  readonly onClose: (row: SwipeableMethods) => void;
}) {
  const t = useUiTranslation();
  const row = useRef<SwipeableMethods | null>(null);
  const [open, setOpen] = useState(false);
  const ignoreLabel = t("Ignore");
  const createLabel = t("Create task");
  const ignore = () => {
    if (!canIgnore) return;
    row.current?.close();
    onIgnore();
  };
  const create = () => {
    if (!canCreate) return;
    row.current?.close();
    onCreate();
  };
  const willOpen = () => {
    if (row.current) onWillOpen(row.current);
  };
  return (
    <ReanimatedSwipeable
      ref={row}
      dragOffsetFromRight={-8}
      failOffsetY={FAIL_OFFSET_Y}
      enableTrackpadTwoFingerGesture
      enabled={canCreate || canIgnore}
      overshootRight={false}
      rightThreshold={ACTIONS_WIDTH * 0.42}
      onSwipeableOpenStartDrag={willOpen}
      onSwipeableWillOpen={willOpen}
      onSwipeableOpen={() => setOpen(true)}
      onSwipeableClose={() => {
        setOpen(false);
        if (row.current) onClose(row.current);
      }}
      renderRightActions={(_progress, translation) => (
        <View
          className="flex-row bg-screen"
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? "auto" : "no-hide-descendants"}
        >
          <SwipeActionButton
            accessibilityLabel={ignoreLabel}
            label={ignoreLabel}
            icon="eye.slash"
            tone="secondary"
            disabled={!canIgnore}
            actionsWidth={ACTIONS_WIDTH}
            rowHeight={0}
            compact={false}
            entryRange={IGNORE_REVEAL}
            translation={translation}
            onPress={ignore}
          />
          <SwipeActionButton
            accessibilityLabel={createLabel}
            label={createLabel}
            icon="plus"
            tone="primary"
            disabled={!canCreate}
            actionsWidth={ACTIONS_WIDTH}
            rowHeight={0}
            compact={false}
            entryRange={CREATE_REVEAL}
            translation={translation}
            onPress={create}
          />
        </View>
      )}
    >
      <View
        accessible
        accessibilityActions={[
          ...(canIgnore ? [{ name: "ignore", label: ignoreLabel }] : []),
          ...(canCreate ? [{ name: "create", label: createLabel }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "ignore") ignore();
          if (nativeEvent.actionName === "create") create();
        }}
        className="gap-2 border-t border-border-subtle bg-screen py-3"
      >
        <Text className="font-t3-medium">{candidate.title}</Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={2}>
          {candidate.description}
        </Text>
        <View className="flex-row justify-end">
          <EnvironmentTag label={environmentLabel} />
        </View>
      </View>
    </ReanimatedSwipeable>
  );
}
