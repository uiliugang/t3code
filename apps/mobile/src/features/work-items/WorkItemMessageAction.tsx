import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";

export function WorkItemMessageAction(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly threadTitle: string;
  readonly text: string;
}) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const config = useEnvironmentServerConfig(props.environmentId);
  const allowed = useAtomValue(
    serverEnvironment.mutateWorkItem.permissionAtom(props.environmentId),
  );
  if (config?.workItems !== true || !props.text.trim()) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Create task from message")}
      accessibilityState={{ disabled: !allowed }}
      disabled={!allowed}
      hitSlop={8}
      className="size-7 items-center justify-center"
      onPress={() =>
        navigation.navigate("Requirements", {
          environmentId: props.environmentId,
          sourceThreadId: props.threadId,
          sourceMessageId: props.messageId,
          sourceTitle: props.threadTitle,
          sourceText: props.text,
        })
      }
    >
      <SymbolView name="checkmark.circle" size={14} tintColorClassName="accent-icon" />
    </Pressable>
  );
}
