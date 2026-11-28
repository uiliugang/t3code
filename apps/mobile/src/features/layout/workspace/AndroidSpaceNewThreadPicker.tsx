import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { sidebarSpaceProjectKey } from "@t3tools/client-runtime/sidebar-spaces";
import { AppText } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { Sheet } from "../../../components/ui/Sheet";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import { useSavedRemoteConnections } from "../../../state/use-remote-environment-registry";

export function AndroidSpaceNewThreadPicker(props: {
  readonly projects: readonly EnvironmentProject[];
  readonly onPick: (project: EnvironmentProject) => void;
  readonly onClose: () => void;
}) {
  const t = useUiTranslation();
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  return (
    <Sheet title={t("New thread")} onClose={props.onClose}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: Math.max(20, insets.bottom) }}
      >
        {props.projects.length === 0 ? (
          <AppText className="text-sm text-foreground-secondary">
            {t("No writable projects in this Space.")}
          </AppText>
        ) : (
          <View className="overflow-hidden rounded-2xl bg-grouped-card">
            {props.projects.map((project, index) => (
              <ListChoiceRow
                key={sidebarSpaceProjectKey({
                  environmentId: project.environmentId,
                  projectId: project.id,
                })}
                label={project.title}
                description={savedConnectionsById[project.environmentId]?.environmentLabel}
                separated={index > 0}
                selected={false}
                onPress={() => props.onPick(project)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </Sheet>
  );
}
