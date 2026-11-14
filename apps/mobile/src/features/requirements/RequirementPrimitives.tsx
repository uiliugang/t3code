import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { Preferences } from "../../persistence/mobile-preferences";

export function ProjectTag({ title }: { title: string }) {
  return (
    <View className="max-w-48 self-start rounded bg-secondary px-2 py-1">
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

export function useRequirementGroups() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const collapsed = AsyncResult.getOrElse(preferences, (): Preferences => ({}))
    .requirementCollapsedGroups ?? ["done", "local:done"];
  return {
    collapsed,
    toggle: (key: string) => {
      void update({
        transform: (current) => {
          const previous = current.requirementCollapsedGroups ?? ["done", "local:done"];
          return {
            requirementCollapsedGroups: previous.includes(key)
              ? previous.filter((entry) => entry !== key)
              : [...previous, key],
          };
        },
      });
    },
  };
}

export function Disclosure({
  title,
  children,
  count,
  open: controlledOpen,
  onToggle,
}: {
  title: string;
  children: ReactNode;
  count?: number;
  open?: boolean;
  onToggle?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = controlledOpen ?? expanded;
  return (
    <View className="border-t border-border-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={onToggle ?? (() => setExpanded(!expanded))}
        className="min-h-12 flex-row items-center gap-2 py-2"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-foreground-muted"
        />
        <Text className="text-sm font-t3-medium">{title}</Text>
        {count !== undefined ? (
          <Text className="text-xs text-foreground-muted">{count}</Text>
        ) : null}
      </Pressable>
      {open ? <View className="gap-3 pb-3">{children}</View> : null}
    </View>
  );
}
