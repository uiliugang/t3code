import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";
import { virtualModelDescription } from "@t3tools/shared/virtualModelEditor";
import { virtualModelName } from "@t3tools/shared/virtualModels";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListRow } from "../../components/ui/ListRow";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import type { SettingsTarget } from "./settings-environment-filter";
import type { ServerProvider } from "@t3tools/contracts";

export function VirtualModelSections({
  environment,
  canManage,
  providers,
}: {
  environment: SettingsTarget;
  canManage: boolean;
  providers: readonly ServerProvider[];
}) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const { environmentId, serverConfig } = environment;
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? serverConfig.settings;
  const allowed =
    useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId)) && canManage;
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [removing, setRemoving] = useState(false);
  if (!settings.virtualModels) return null;
  const edit = (id?: string) =>
    navigation.navigate("SettingsVirtualModel", {
      environmentId,
      id: id ?? uuidv4(),
      create: id === undefined,
    });
  const generators = Object.entries(settings.textGenerators);
  return (
    <>
      <SettingsSection title={t("Text generators")}>
        {generators.length ? (
          generators.map(([key, config]) => (
            <View key={key} className="gap-1 px-4 py-3">
              <Text>{config.label ?? key}</Text>
              <Text className="text-sm text-foreground-muted">
                {config.model ?? new URL(config.baseUrl).host}
              </Text>
            </View>
          ))
        ) : (
          <Text className="p-4 text-foreground-muted">{t("No text generators yet")}</Text>
        )}
      </SettingsSection>
      <SettingsSection
        title={t("Virtual models")}
        trailing={
          allowed ? (
            <ControlPill
              icon="plus"
              accessibilityLabel={t("Add virtual model")}
              onPress={() => edit()}
            />
          ) : null
        }
      >
        {Object.entries(settings.virtualModels).map(([id, entry]) => {
          const name = entry.name ?? virtualModelName(id, t);
          const description = virtualModelDescription(settings, id, providers, t);
          return (
            <View key={id} className="flex-row items-center border-b border-border-subtle">
              <View className="min-w-0 flex-1">
                {allowed ? (
                  <ListRow
                    icon="link"
                    label={name}
                    description={description}
                    onPress={() => edit(id)}
                  />
                ) : (
                  <View className="gap-1 px-4 py-3">
                    <Text>{name}</Text>
                    <Text className="text-sm text-foreground-muted">{description}</Text>
                  </View>
                )}
              </View>
              {allowed && !removing ? (
                <Menu
                  accessibilityLabel={t("More actions for {name}", { name })}
                  actions={[
                    { id: "edit", title: t("Edit") },
                    { id: "remove", title: t("Remove"), attributes: { destructive: true } },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "edit") edit(id);
                    else if (nativeEvent.event === "remove")
                      Dialog.confirm({
                        title: t("Remove {name}?", { name }),
                        message: t(
                          "This removes the virtual model without changing existing references. Requests using those references will fail.",
                        ),
                        confirmText: t("Remove"),
                        destructive: true,
                        onConfirm: async () => {
                          setRemoving(true);
                          await update({
                            environmentId,
                            input: { patch: { virtualModels: { [id]: null } } },
                          });
                          setRemoving(false);
                        },
                      });
                  }}
                >
                  <View className="size-12 items-center justify-center">
                    <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon" />
                  </View>
                </Menu>
              ) : null}
            </View>
          );
        })}
        {Object.keys(settings.virtualModels).length === 0 ? (
          <Text className="p-4 text-foreground-muted">{t("No models found")}</Text>
        ) : null}
      </SettingsSection>
    </>
  );
}
