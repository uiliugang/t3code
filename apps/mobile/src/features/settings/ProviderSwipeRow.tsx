import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isManagedSettingPath, type ServerProvider } from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { View, useWindowDimensions } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import * as Dialog from "../../components/ui/Dialog";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SettingsTarget } from "./settings-environment-filter";

export type ProviderRowRenderer = (content: ReactNode, onEdit?: () => void) => ReactNode;

export function ProviderSwipeRow({
  environment,
  provider,
  onError,
  onEdit,
  onSwipeableClose,
  onSwipeableWillOpen,
  children,
}: {
  readonly environment: SettingsTarget;
  readonly provider: Pick<ServerProvider, "instanceId" | "displayName" | "driver" | "enabled">;
  readonly onError: (error: string | null) => void;
  readonly onEdit?: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly children: ReactNode;
}) {
  const t = useUiTranslation();
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, { reportFailure: false });
  const allowed = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environment.environmentId),
  );
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const { width } = useWindowDimensions();
  const supported =
    environment.serverConfig.environment.capabilities.providerInstanceDeletion === true;
  const name = provider.displayName ?? provider.instanceId;
  const canToggle =
    allowed &&
    !isManagedSettingPath(
      environment.serverConfig.managedPolicy,
      `providerInstances.${provider.instanceId}.enabled`,
    );
  const setEnabled = () => {
    if (!canToggle || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    onError(null);
    void mutate({
      environmentId: environment.environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: provider.instanceId,
          instance: {
            driver: provider.driver,
            ...environment.serverConfig.settings.providerInstances[provider.instanceId],
            enabled: !provider.enabled,
          },
        },
      },
    }).then((result) => {
      pendingRef.current = false;
      setPending(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        onError(failure instanceof Error ? failure.message : t("Could not update provider"));
      }
    });
  };
  const toggle = () => {
    if (!canToggle || pendingRef.current) return;
    if (!provider.enabled) return setEnabled();
    Dialog.alert(
      t("Disable {name}?", { name }),
      t("Disabling may interrupt active sessions. Saved settings and credentials will be kept."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Disable"), onPress: setEnabled },
      ],
    );
  };
  const toggleAction = {
    accessibilityLabel: `${provider.enabled ? t("Disable") : t("Enable")}: ${name}`,
    icon: provider.enabled ? ("pause" as const) : ("play" as const),
    disabled: !canToggle,
    onPress: toggle,
  };
  const remove = () => {
    if (!allowed || pendingRef.current) return;
    if (!supported) {
      onError(t("Update this environment's server to remove providers."));
      return;
    }
    Dialog.alert(
      t("Remove {name}?", { name }),
      t(
        "Active sessions will be stopped. Saved settings and unused T3-managed resources will be removed. Personal CLI installations and configuration will be kept.",
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Remove"),
          style: "destructive",
          onPress: () => {
            if (!allowed || pendingRef.current) return;
            pendingRef.current = true;
            setPending(true);
            onError(null);
            void mutate({
              environmentId: environment.environmentId,
              input: {
                patch: {},
                providerInstanceMutation: {
                  operation: "delete",
                  instanceId: provider.instanceId,
                },
              },
            }).then((result) => {
              pendingRef.current = false;
              setPending(false);
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const failure = squashAtomCommandFailure(result);
                onError(
                  failure instanceof Error
                    ? failure.message
                    : t("Could not delete provider instance"),
                );
              }
            });
          },
        },
      ],
    );
  };
  return (
    <ThreadSwipeable
      backgroundColor="transparent"
      enabled={allowed && !pending}
      fullSwipeAction="delete"
      fullSwipeWidth={width - 40}
      onDelete={remove}
      onSwipeableClose={onSwipeableClose}
      onSwipeableWillOpen={onSwipeableWillOpen}
      primaryAction={
        onEdit
          ? { accessibilityLabel: `${t("Edit")}: ${name}`, icon: "pencil", onPress: onEdit }
          : toggleAction
      }
      middleAction={onEdit ? toggleAction : undefined}
      secondaryAction={{
        accessibilityLabel: `${t("Remove provider")}: ${name}`,
        destructive: true,
        icon: "trash",
        onPress: remove,
      }}
      threadKey={`${environment.environmentId}:${provider.instanceId}`}
      threadTitle={name}
    >
      {() => <View className="bg-grouped-card">{children}</View>}
    </ThreadSwipeable>
  );
}
