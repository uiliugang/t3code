import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Linking, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { ThreadId, type EnvironmentId, type WechatMutation } from "@t3tools/contracts";
import { QrCode } from "@t3tools/shared/qrCode";
import {
  wechatStatusMessages,
  wechatDeliveryMessages,
  wechatErrorMessages,
} from "@t3tools/shared/wechat";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { KeyboardSheetBody } from "../../components/ui/KeyboardSheetBody";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { Sheet } from "../../components/ui/Sheet";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { SettingsSection } from "./components/SettingsSection";

function PairingCode({ value }: { value: string }) {
  const qr = QrCode.encodeText(value, QrCode.Ecc.LOW);
  const modules: string[] = [];
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.getModule(x, y)) modules.push(`M${x + 4} ${y + 4}h1v1h-1z`);
  return (
    <Svg width={176} height={176} viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}>
      <Rect width="100%" height="100%" fill="#fff" />
      <Path d={modules.join("")} fill="#000" />
    </Svg>
  );
}

export function WechatSettingsSection({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const allowed = useAtomValue(serverEnvironment.mutateWechat.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    allowed ? serverEnvironment.wechat({ environmentId, input: {} }) : null,
  );
  const mutate = useAtomCommand(serverEnvironment.mutateWechat, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState("");
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const state = query.data;
  const errorMessage =
    failed || query.error || state?.error
      ? t(
          state?.error
            ? wechatErrorMessages[state.error]
            : "Could not update WeChat. Check the connection and try again.",
        )
      : null;
  const run = async (input: WechatMutation) => {
    if (busy || !allowed) return false;
    setBusy(true);
    setFailed(false);
    const result = await mutate({ environmentId, input });
    setBusy(false);
    setFailed(result._tag !== "Success");
    return result._tag === "Success";
  };
  return (
    <>
      <SettingsSection title="WeChat">
        <View className="gap-4 p-4">
          <Text className="text-sm text-foreground-muted">
            {t("Continue a T3 thread from WeChat and receive results while you are away.")}
          </Text>
          <Text accessibilityRole="text" className="text-sm font-t3-medium">
            {state
              ? t(wechatStatusMessages[state.status])
              : t(allowed ? "Loading..." : "Access management permission required.")}
          </Text>
          {errorMessage && (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {errorMessage}
            </Text>
          )}
          {state && !state.botId && !state.qrCode && (
            <>
              <Text className="text-sm text-foreground-muted">
                {t(
                  "Pair with your WeChat account. Only the paired user can send tasks to the selected thread. Messages and results pass through WeChat.",
                )}
              </Text>
              <Button
                label={t(state.status === "expired" ? "Refresh pairing" : "Connect WeChat")}
                loading={busy}
                disabled={!allowed}
                onPress={() => run({ type: "connect" })}
              />
            </>
          )}
          {state?.qrCode && (
            <>
              <View accessibilityLabel={t("WeChat pairing QR code")}>
                <PairingCode value={state.qrCode} />
              </View>
              <Text className="text-sm">
                {t(
                  "Scan with WeChat and confirm on your phone. After pairing, send the bot a message to activate this connection.",
                )}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {t("On the same phone, open the pairing link or scan from another screen.")}
              </Text>
              {state.qrCode.startsWith("https://") && (
                <Button
                  label={t("Open pairing link")}
                  onPress={() => {
                    void Linking.openURL(state.qrCode!);
                  }}
                />
              )}
              {state.status === "verify" && (
                <>
                  <ConnectionFormField
                    label={t("Verification code shown on your phone")}
                    value={code}
                    keyboardType="number-pad"
                    onChangeText={(value) => setCode(value.replace(/\D/gu, "").slice(0, 12))}
                  />
                  <Button
                    label={t("Verify")}
                    disabled={!/^\d{1,12}$/u.test(code)}
                    loading={busy}
                    onPress={() => run({ type: "verify", code })}
                  />
                </>
              )}
              <Button
                label={t("Cancel pairing")}
                loading={busy}
                onPress={() => run({ type: "cancel" })}
              />
            </>
          )}
          {state?.botId && (
            <>
              {state.bindingCode && (
                <Text className="text-sm">
                  {t("Send /bind {code} to the bot in WeChat to verify your identity.", {
                    code: state.bindingCode,
                  })}
                </Text>
              )}
              {!state.activated && (
                <Text className="text-sm">
                  {t("Paired. Send the bot a message in WeChat to activate replies.")}
                </Text>
              )}
              <View className="-mx-4">
                <ListRow
                  label={t("Target thread")}
                  description={
                    state.targets.find((target) => target.threadId === state.threadId)?.title ??
                    t("Select a thread")
                  }
                  disabled={busy || !allowed}
                  onPress={() => {
                    setSearch("");
                    setPicking(true);
                  }}
                />
                <ListToggleRow
                  label={t("Push task results")}
                  value={state.pushEnabled}
                  disabled={busy || !allowed || !state.threadId}
                  onValueChange={(pushEnabled) => {
                    if (state.threadId)
                      run({
                        type: "configure",
                        threadId: state.threadId,
                        pushEnabled,
                        pushAllThreads: state.pushAllThreads,
                      });
                  }}
                />
                <ListToggleRow
                  label={t("Include all threads and scheduled tasks in this project")}
                  value={state.pushAllThreads}
                  disabled={busy || !allowed || !state.threadId || !state.pushEnabled}
                  onValueChange={(pushAllThreads) => {
                    if (state.threadId)
                      run({
                        type: "configure",
                        threadId: state.threadId,
                        pushEnabled: state.pushEnabled,
                        pushAllThreads,
                      });
                  }}
                />
              </View>
              <Text className="text-sm text-foreground-muted">
                {t(
                  "Results remain queued across server restarts. Keep this environment running for continuous delivery.",
                )}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={t(state.enabled ? "Pause WeChat" : "Resume WeChat")}
                  loading={busy}
                  disabled={!allowed}
                  onPress={() => run({ type: "enabled", enabled: !state.enabled })}
                />
                <Button
                  label={t("Send test push")}
                  disabled={!allowed || !state.enabled || !state.activated}
                  loading={busy}
                  onPress={() => run({ type: "test" })}
                />
                <Button
                  label={t("Unlink")}
                  tone="danger"
                  disabled={busy || !allowed}
                  onPress={() =>
                    Dialog.confirm({
                      title: t("Unlink WeChat"),
                      message: t(
                        "Unlink WeChat? This removes local credentials and pending deliveries. Existing T3 tasks keep running.",
                      ),
                      confirmText: t("Unlink"),
                      cancelText: t("Cancel"),
                      destructive: true,
                      onConfirm: () => run({ type: "unlink" }),
                    })
                  }
                />
              </View>
            </>
          )}
          {query.error && <Button label={t("Retry")} onPress={query.refresh} />}
        </View>
      </SettingsSection>
      {state?.botId && state.deliveries.length > 0 && (
        <SettingsSection title="Recent deliveries">
          {state.deliveries.slice(0, 5).map((delivery) => (
            <View key={delivery.id} className="gap-2 border-b border-border-subtle p-4">
              <Text className="text-sm" numberOfLines={3}>
                {delivery.preview}
              </Text>
              <View className="flex-row items-center justify-between gap-3">
                <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
                  {t(wechatDeliveryMessages[delivery.status])}
                </Text>
                {["failed", "unknown"].includes(delivery.status) && (
                  <Button
                    label={t("Retry delivery")}
                    disabled={busy || !allowed || !state.enabled}
                    onPress={() =>
                      delivery.status === "unknown"
                        ? Dialog.confirm({
                            title: t("Retry delivery"),
                            message: t(
                              "The previous delivery may have arrived. Retrying can send a duplicate.",
                            ),
                            confirmText: t("Retry"),
                            cancelText: t("Cancel"),
                            onConfirm: () => run({ type: "retry", deliveryId: delivery.id }),
                          })
                        : run({ type: "retry", deliveryId: delivery.id })
                    }
                  />
                )}
              </View>
            </View>
          ))}
        </SettingsSection>
      )}
      {picking && state?.botId && (
        <Sheet
          title={t("Target thread")}
          onClose={() => setPicking(false)}
          dismissDisabled={busy}
          expanded
        >
          <KeyboardSheetBody>
            <View className="gap-3 pb-3">
              <ConnectionFormField
                label={t("Search threads")}
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {errorMessage && (
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {errorMessage}
                </Text>
              )}
            </View>
            <LegendList
              renderScrollComponent={NativeScrollView}
              extraData={{ busy, allowed, state, run }}
              estimatedItemSize={64}
              className="flex-1"
              contentInsetAdjustmentBehavior="never"
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              data={state.targets.filter((target) =>
                target.title.toLowerCase().includes(search.trim().toLowerCase()),
              )}
              keyExtractor={(target) => target.threadId}
              ListEmptyComponent={
                <Text className="px-4 py-3 text-sm text-foreground-muted">
                  {t(search.trim() ? "No matching threads" : "No threads found")}
                </Text>
              }
              renderItem={({ item: target }) => (
                <SelectionRow
                  key={target.threadId}
                  title={target.title}
                  selected={target.threadId === state.threadId}
                  disabled={busy || !allowed}
                  onPress={async () => {
                    const saved = await run({
                      type: "configure",
                      threadId: ThreadId.make(target.threadId),
                      pushEnabled: state.pushEnabled,
                      pushAllThreads: state.pushAllThreads,
                    });
                    if (saved) setPicking(false);
                  }}
                />
              )}
            />
          </KeyboardSheetBody>
        </Sheet>
      )}
    </>
  );
}
