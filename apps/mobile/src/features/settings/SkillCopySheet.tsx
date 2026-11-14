import { useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type SkillCopyPreview,
  type SkillCopySource,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { ControlPill } from "../../components/ui/ControlPill";
import { Sheet } from "../../components/ui/Sheet";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";

export function SkillCopySheet({
  environmentId,
  items,
  onClose,
}: {
  environmentId: EnvironmentId;
  items: ReadonlyArray<{ name: string; source: SkillCopySource }>;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const targets = environments.filter((env) => env.environmentId !== environmentId);
  const [targetId, setTargetId] = useState<EnvironmentId | null>(
    targets.find((env) => env.connection.phase === "connected")?.environmentId ?? null,
  );
  const [directory, setDirectory] = useState<string | null>(null);
  const [preview, setPreview] = useState<SkillCopyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [error, setError] = useState("");
  const query = useEnvironmentQuery(
    serverEnvironment.skills({ environmentId: targetId ?? environmentId, input: {} }),
  );
  const permitted = useAtomValue(
    serverEnvironment.copySkill.permissionAtom(targetId ?? environmentId),
  );
  const sourcePermitted = useAtomValue(serverEnvironment.exportSkill.permissionAtom(environmentId));
  const exporter = useAtomCommand(serverEnvironment.exportSkill);
  const copier = useAtomCommand(serverEnvironment.copySkill);
  const reviewer = useAtomCommand(serverEnvironment.previewSkillCopy);
  const target = targets.find((env) => env.environmentId === targetId);
  const destination =
    directory ??
    query.data?.targets.find((entry) => entry.id === "directory:shared")?.directory ??
    "";
  const canCopy =
    !!target && target.connection.phase === "connected" && permitted && sourcePermitted;
  const remaining = items.filter((item) => !submitted.includes(item.name));
  const review = async () => {
    if (!targetId) return;
    setBusy(true);
    setError("");
    const result = await reviewer({
      environmentId: targetId,
      input: { directory: destination, names: items.map((item) => item.name) },
    });
    if (result._tag === "Success") setPreview(result.value);
    else
      setError(t("Could not preview the destination. Check its connection, permissions and path."));
    setBusy(false);
  };
  const submit = async () => {
    if (!targetId || !preview) return;
    setBusy(true);
    setError("");
    for (const item of remaining) {
      const exported = await exporter({ environmentId, input: item.source });
      if (exported._tag !== "Success" || exported.value.name !== item.name) {
        setError(t("Could not copy {name}. Refresh the source and retry.", { name: item.name }));
        break;
      }
      const result = await copier({
        environmentId: targetId,
        input: { directory: preview.directory, package: exported.value },
      });
      if (result._tag !== "Success") {
        setError(t("Could not copy {name}. Check the destination and retry.", { name: item.name }));
        break;
      }
      setSubmitted((current) => [...current, item.name]);
    }
    setBusy(false);
  };
  return (
    <Sheet
      title={t(preview ? "Confirm copy" : "Copy to another environment")}
      onClose={onClose}
      dismissDisabled={busy}
      expanded
    >
      <View className="flex-1">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 20 }}
        >
          <View className="gap-5 p-5">
            {new Set(items.map((item) => item.name)).size !== items.length && (
              <Text accessibilityRole="alert" className="text-danger">
                {t(
                  "Duplicate names selected: {names}. Close this dialog and select only one source for each name.",
                  {
                    names: [
                      ...new Set(
                        items
                          .filter(
                            (item, index) =>
                              items.findIndex((other) => other.name === item.name) !== index,
                          )
                          .map((item) => item.name),
                      ),
                    ].join(", "),
                  },
                )}
              </Text>
            )}
            <Text className="text-xs text-foreground-muted">
              {environments.find((env) => env.environmentId === environmentId)?.label} →{" "}
              {target?.label ?? t("Choose environment")}
            </Text>
            {!preview ? (
              <>
                <View className="gap-2">
                  <Text className="text-sm font-t3-medium">{t("Destination environment")}</Text>
                  <Menu
                    actions={targets.map((env) => ({
                      id: env.environmentId,
                      title: env.displayUrl ? `${env.label} · ${env.displayUrl}` : env.label,
                      attributes: {
                        disabled:
                          env.connection.phase !== "connected" || busy || submitted.length > 0,
                      },
                    }))}
                    onPressAction={({ nativeEvent }) => {
                      setTargetId(
                        targets.find((env) => env.environmentId === nativeEvent.event)
                          ?.environmentId ?? null,
                      );
                      setDirectory(null);
                      setError("");
                    }}
                  >
                    <ControlPill
                      label={target?.label ?? t("Choose environment")}
                      disabled={busy || submitted.length > 0}
                    />
                  </Menu>
                </View>
                <View className="gap-2">
                  <Text className="text-sm font-t3-medium">{t("Destination directory")}</Text>
                  <TextInput
                    accessibilityLabel={t("Destination directory")}
                    value={destination}
                    onChangeText={setDirectory}
                    editable={!busy && submitted.length === 0}
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="rounded-lg border border-border-subtle px-3 py-3 text-foreground"
                  />
                </View>
              </>
            ) : (
              <View className="gap-2">
                <Text className="text-xs text-foreground-muted">{t("Destination directory")}</Text>
                <Text selectable className="text-sm">
                  {preview.directory}
                </Text>
              </View>
            )}
            {!targets.length && (
              <Text className="text-foreground-muted">
                {t("Connect another environment to copy skills.")}
              </Text>
            )}
            {targetId && !canCopy && (
              <Text accessibilityRole="alert" className="text-foreground-muted">
                {t("Both environments must be connected with permission to manage skills.")}
              </Text>
            )}
            <View>
              <Text className="mb-2 text-sm font-t3-medium">
                {t("{count} skills", { count: items.length })}
              </Text>
              {items.map((item) => {
                const entry = preview?.entries.find((entry) => entry.name === item.name);
                return (
                  <View
                    key={item.name}
                    className="flex-row items-center gap-3 border-t border-border-subtle py-4"
                  >
                    <Text className="min-w-0 flex-1 text-sm font-t3-medium">{item.name}</Text>
                    <Text className="shrink-0 text-xs text-foreground-muted">
                      {t(
                        submitted.includes(item.name)
                          ? "Queued"
                          : !entry
                            ? "Not checked"
                            : entry.status === "new"
                              ? "New"
                              : entry.status === "skill"
                                ? "Overwrite skill"
                                : "Overwrite directory",
                      )}
                    </Text>
                  </View>
                );
              })}
            </View>
            {preview?.entries.some((entry) => entry.status !== "new") && (
              <View className="rounded-lg bg-subtle p-3">
                <Text className="text-sm">
                  {t(
                    "Matching skills or directories will be fully replaced, including old files missing from the source. Other directories are unchanged.",
                  )}
                </Text>
              </View>
            )}
            {submitted.length > 0 && (
              <Text accessibilityRole="alert" className="text-foreground-muted">
                {t(
                  "{count} queued. View results in Recent operations on the destination environment.",
                  { count: submitted.length },
                )}
              </Text>
            )}
            {error && (
              <Text accessibilityRole="alert" className="text-danger">
                {error}
              </Text>
            )}
          </View>
        </ScreenScrollView>
        <View
          className="gap-2 border-t border-border-subtle px-5 pt-4"
          style={{ paddingBottom: Math.max(16, insets.bottom) }}
        >
          <Button
            fullWidth
            tone="primary"
            label={t(
              busy
                ? "Working..."
                : !remaining.length
                  ? "Done"
                  : preview
                    ? "Copy and overwrite ({count})"
                    : "Next",
              { count: remaining.length },
            )}
            disabled={
              busy ||
              (remaining.length > 0 &&
                (!canCopy ||
                  !destination ||
                  new Set(items.map((item) => item.name)).size !== items.length))
            }
            onPress={() => {
              if (!remaining.length) onClose();
              else void (preview ? submit() : review());
            }}
          />
          {preview && !submitted.length && (
            <Button
              fullWidth
              tone="text"
              label={t("Back")}
              disabled={busy}
              onPress={() => setPreview(null)}
            />
          )}
        </View>
      </View>
    </Sheet>
  );
}
