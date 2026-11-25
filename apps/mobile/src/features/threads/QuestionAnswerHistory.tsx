import type {
  EnvironmentId,
  UserInputAttachmentAnswerPayload,
  UserInputAttachments,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { useNavigation } from "@react-navigation/native";
import { usePreparedConnection } from "../../state/session";
import { Pressable, View } from "react-native";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { getQuestionAnswerText } from "@t3tools/client-runtime/work-log/user-input";
import { AppText as Text } from "../../components/ui/AppText";
import { assetImageSource } from "../../lib/assetImageSource";
import { useAssetUrl } from "../../state/assets";

function AnswerFile(props: {
  environmentId: EnvironmentId;
  attachment: UserInputAttachments[string][number];
}) {
  const resource = { _tag: "attachment", attachmentId: props.attachment.id } as const;
  const navigation = useNavigation();
  const connection = usePreparedConnection(props.environmentId);
  const noise = connection._tag === "Some" && connection.value.transport === "noise";
  const url = useAssetUrl(
    props.environmentId,
    !noise || props.attachment.type === "image" ? resource : null,
  );

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={props.attachment.name}
      disabled={!noise && !url}
      onPress={() => {
        if (noise) {
          navigation.navigate("ThreadAttachment", {
            environmentId: String(props.environmentId),
            attachmentId: props.attachment.id,
            name: props.attachment.name,
            mimeType: props.attachment.mimeType,
            sizeBytes: String(props.attachment.sizeBytes),
          });
        } else if (url) void tryOpenExternalUrl(url);
      }}
      className="gap-1"
    >
      {props.attachment.type === "image" && url ? (
        <Image
          source={assetImageSource(props.environmentId, resource, url)}
          cachePolicy="memory-disk"
          style={{ width: 160, height: 96 }}
          contentFit="contain"
        />
      ) : null}
      <Text className="text-sm text-foreground underline">{props.attachment.name}</Text>
    </Pressable>
  );
}

export function QuestionAnswerHistory(props: {
  environmentId: EnvironmentId;
  answer: UserInputAttachmentAnswerPayload;
}) {
  return (
    <View className="gap-2">
      {[
        ...new Set([
          ...Object.keys(props.answer.questionTextById ?? {}),
          ...Object.keys(props.answer.answers),
          ...Object.keys(props.answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <View key={questionId} className="gap-1">
          {props.answer.questionTextById?.[questionId] ? (
            <Text className="text-sm text-foreground-muted">
              {props.answer.questionTextById[questionId]}
            </Text>
          ) : null}
          {getQuestionAnswerText(props.answer.answers[questionId]) ? (
            <Text className="ml-3 text-sm text-foreground-muted">
              {getQuestionAnswerText(props.answer.answers[questionId])}
            </Text>
          ) : null}
          {(props.answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => (
            <AnswerFile
              key={attachment.id}
              environmentId={props.environmentId}
              attachment={attachment}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
