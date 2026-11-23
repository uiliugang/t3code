import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { useSavedRemoteConnections } from "../../../state/use-remote-environment-registry";
import { AppText } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { Sheet } from "../../../components/ui/Sheet";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  normalizeSidebarSpaceName,
  sidebarSpaceProjectKey,
} from "@t3tools/client-runtime/sidebar-spaces";
import type { ScopedProjectRef } from "@t3tools/contracts";
import type { AndroidSidebarSpace } from "./android-sidebar-spaces";

function refOf(project: EnvironmentProject): ScopedProjectRef {
  return { environmentId: project.environmentId, projectId: project.id };
}

export function AndroidSidebarSpaceControls(props: {
  readonly spaces: readonly AndroidSidebarSpace[];
  readonly selected: AndroidSidebarSpace | null;
  readonly available: readonly EnvironmentProject[];
  readonly selectedThreadOutsideSpace: boolean;
  readonly onSelect: (space: AndroidSidebarSpace | null) => void;
  readonly onSave: (
    input: { readonly name: string; readonly projectRefs: readonly ScopedProjectRef[] },
    previous: AndroidSidebarSpace | null,
  ) => void;
  readonly onDelete: (space: AndroidSidebarSpace) => void;
}) {
  const t = useUiTranslation();
  const [sheet, setSheet] = useState<"picker" | "create" | "edit" | "delete" | null>(null);
  const insets = useSafeAreaInsets();
  const close = () => setSheet(null);
  const select = (space: AndroidSidebarSpace | null) => {
    close();
    props.onSelect(space);
  };
  return (
    <View
      className="border-t border-border-subtle bg-header"
      style={{ paddingBottom: insets.bottom }}
    >
      {props.selected !== null && props.selectedThreadOutsideSpace ? (
        <View className="px-3">
          <Button
            label={t("Return to Space")}
            tone="text"
            onPress={() => props.onSelect(props.selected)}
          />
        </View>
      ) : null}
      <View className="min-h-14 flex-row items-center justify-between gap-1 px-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.selected?.name ?? t("All projects")}
          accessibilityHint={t("Switch Space")}
          onPress={() => setSheet("picker")}
          className="min-h-12 min-w-0 flex-1 flex-row items-center gap-2 rounded-full px-2 active:bg-subtle"
        >
          <SymbolView name="square.grid.2x2" size={18} tintColorClassName="accent-icon" />
          <AppText
            className="min-w-0 shrink font-t3-medium text-header-foreground"
            numberOfLines={1}
          >
            {props.selected?.name ?? t("All projects")}
          </AppText>
          <SymbolView name="chevron.down" size={14} tintColorClassName="accent-icon-subtle" />
        </Pressable>
        <IconButton
          accessibilityLabel={t("Add Space")}
          icon="plus"
          variant="tonal"
          onPress={() => setSheet("create")}
        />
      </View>
      {sheet === "picker" ? (
        <Sheet title={t("Spaces")} onClose={close}>
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: Math.max(20, insets.bottom) }}
          >
            <View className="overflow-hidden rounded-2xl bg-grouped-card">
              <ListChoiceRow
                label={t("All projects")}
                selected={props.selected === null}
                onPress={() => select(null)}
              />
              {props.spaces.map((space) => (
                <ListChoiceRow
                  key={space.id}
                  label={space.name}
                  selected={props.selected?.id === space.id}
                  onPress={() => select(space)}
                  separated
                />
              ))}
            </View>
            {props.selected ? (
              <View className="mt-3 flex-row flex-wrap">
                <Button label={t("Edit Space")} tone="text" onPress={() => setSheet("edit")} />
                <Button label={t("Delete Space")} tone="text" onPress={() => setSheet("delete")} />
              </View>
            ) : null}
          </ScrollView>
        </Sheet>
      ) : null}
      {sheet === "create" || (sheet === "edit" && props.selected !== null) ? (
        <SpaceEditor
          key={sheet === "create" ? "create" : props.selected?.id}
          space={sheet === "create" ? null : props.selected}
          available={props.available}
          spaces={props.spaces}
          onClose={close}
          onSave={(input, previous) => {
            close();
            props.onSave(input, previous);
          }}
        />
      ) : null}
      {sheet === "delete" && props.selected !== null ? (
        <Sheet title={t("Delete Space")} onClose={close}>
          <View className="gap-3 px-4 pb-5">
            <AppText className="text-sm text-foreground-secondary">
              {t("Projects and threads are kept.")}
            </AppText>
            <Button
              label={t("Delete Space")}
              tone="danger"
              onPress={() => {
                if (!props.selected) return;
                close();
                props.onDelete(props.selected);
              }}
            />
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}

function SpaceEditor(props: {
  readonly space: AndroidSidebarSpace | null;
  readonly available: readonly EnvironmentProject[];
  readonly spaces: readonly AndroidSidebarSpace[];
  readonly onClose: () => void;
  readonly onSave: (
    input: { readonly name: string; readonly projectRefs: readonly ScopedProjectRef[] },
    previous: AndroidSidebarSpace | null,
  ) => void;
}) {
  const t = useUiTranslation();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [name, setName] = useState(props.space?.name ?? "");
  const [members, setMembers] = useState<ReadonlyMap<string, ScopedProjectRef>>(
    () => new Map(props.space?.projectRefs.map((ref) => [sidebarSpaceProjectKey(ref), ref])),
  );
  const duplicate = props.spaces.some(
    (space) =>
      space.id !== props.space?.id &&
      normalizeSidebarSpaceName(space.name) === normalizeSidebarSpaceName(name),
  );
  const availableKeys = new Set(
    props.available.map((project) => sidebarSpaceProjectKey(refOf(project))),
  );
  const unavailableCount = [...members.keys()].filter((key) => !availableKeys.has(key)).length;
  const insets = useSafeAreaInsets();
  return (
    <Sheet title={props.space ? t("Edit Space") : t("Add Space")} onClose={props.onClose}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: Math.max(20, insets.bottom), gap: 12 }}
      >
        <TextInput
          accessibilityLabel={t("Space name")}
          placeholder={t("Space name")}
          className="min-h-12 rounded-xl border border-border-subtle bg-grouped-card px-3 text-foreground"
          value={name}
          onChangeText={setName}
          maxLength={64}
        />
        {duplicate ? (
          <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
            {t("A Space already has that name.")}
          </AppText>
        ) : null}
        <AppText className="text-sm text-foreground-secondary">
          {t("Projects in this Space")}
        </AppText>
        <View className="overflow-hidden rounded-2xl bg-grouped-card">
          {props.available.map((project) => {
            const ref = refOf(project);
            const key = sidebarSpaceProjectKey(ref);
            return (
              <ListToggleRow
                key={key}
                label={project.title}
                description={savedConnectionsById[project.environmentId]?.environmentLabel}
                value={members.has(key)}
                onValueChange={(selected) => {
                  setMembers((current) => {
                    const next = new Map(current);
                    if (selected) next.set(key, ref);
                    else next.delete(key);
                    return next;
                  });
                }}
              />
            );
          })}
        </View>
        {unavailableCount ? (
          <Button
            label={t("Remove unavailable projects")}
            tone="text"
            onPress={() =>
              setMembers(
                (current) => new Map([...current].filter(([key]) => availableKeys.has(key))),
              )
            }
          />
        ) : null}
        <Button
          label={t("Save")}
          tone="primary"
          disabled={!name.trim() || duplicate}
          onPress={() =>
            props.onSave({ name: name.trim(), projectRefs: [...members.values()] }, props.space)
          }
        />
      </ScrollView>
    </Sheet>
  );
}
