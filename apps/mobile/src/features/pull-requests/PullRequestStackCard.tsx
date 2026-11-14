import { useUiTranslation } from "../../lib/useUiTranslation";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { pullRequestLayerParams } from "./pullRequestStack";
import { pullRequestStatus } from "./pullRequestStatus";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import { withKnownPullRequestSummary } from "../../state/use-thread-pr";

export function PullRequestStackCard(props: {
  readonly params: PullRequestParams;
  readonly state: PullRequestStackState;
}) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const stack = props.state.stack;
  if (!stack) {
    const summary =
      props.params.initialSummary?.number === props.params.number
        ? props.params.initialSummary.stack
        : undefined;
    if (!summary) return null;
    return (
      <PullRequestCardGroup>
        <PullRequestCardRow
          title={t("Stack")}
          icon={PullRequestGlyph.stack}
          value={t("{position} of {count}", { position: summary.position, count: summary.size })}
          last
        />
      </PullRequestCardGroup>
    );
  }
  const position = stack.layers.findIndex((layer) => layer.number === props.params.number) + 1;
  return (
    <PullRequestCardGroup>
      <PullRequestCardRow
        title={t("Stack")}
        icon={PullRequestGlyph.stack}
        value={t("{position} of {count}", { position, count: stack.layers.length })}
        accessibilityLabel={t("Stack, {position} of {count}{status}", {
          position,
          count: stack.layers.length,
          status: props.state.isFresh ? "" : t(", showing saved stack"),
        })}
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        last={!expanded}
      />
      {expanded ? (
        <View>
          {stack.layers.map((layer, index) => {
            const selected = layer.number === props.params.number;
            const status = pullRequestStatus({
              state: layer.state,
              isDraft: layer.isDraft === true,
            });
            return (
              <View key={layer.number} className={selected ? "bg-thread-selected" : undefined}>
                <PullRequestCardRow
                  title={layer.title ?? layer.headBranch}
                  icon={status.icon}
                  tint={status.tint}
                  value={t(selected ? "Current" : status.label)}
                  detail={t("#{number} · {value} of {count}", {
                    number: String(layer.number),
                    value: String(index + 1),
                    count: String(stack.layers.length),
                  })}
                  onPress={
                    selected
                      ? undefined
                      : () =>
                          navigation.dispatch(
                            StackActions.push(
                              "PullRequest",
                              withKnownPullRequestSummary(
                                pullRequestLayerParams(props.params, layer.number),
                              ),
                            ),
                          )
                  }
                  last={index === stack.layers.length - 1}
                />
              </View>
            );
          })}
          <Text className="px-4 py-3 text-xs text-foreground-muted">
            {t("Base: {branch}. Open a layer to review it or merge the stack through that layer.", {
              branch: stack.base,
            })}
          </Text>
        </View>
      ) : null}
    </PullRequestCardGroup>
  );
}
