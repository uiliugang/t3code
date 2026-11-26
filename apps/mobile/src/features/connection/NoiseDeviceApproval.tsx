import type { EnvironmentId } from "@t3tools/contracts";
import { NoiseApproval } from "@t3tools/client-runtime/relay";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { ListRow } from "../../components/ui/ListRow";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { enrollEncryptedRelay } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";

export function NoiseDeviceApproval({
  initialLink,
  expectedEnvironmentId,
}: {
  readonly initialLink: string;
  readonly expectedEnvironmentId: EnvironmentId | undefined;
}) {
  const gt = useGT();
  const enroll = useAtomCommand(enrollEncryptedRelay, { reportFailure: false });
  const [value, setValue] = useState(initialLink);
  const [result, setResult] = useState<"error" | "changed" | "enrolled" | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = NoiseApproval.readNoisePin(value.trim());
  const pin =
    expectedEnvironmentId && parsed?.environmentId !== expectedEnvironmentId ? null : parsed;
  const submit = async () => {
    if (!pin || busy) return;
    setBusy(true);
    const reply = await enroll({ pin, replacePin: result === "changed" });
    setResult(reply._tag === "Success" ? reply.value.status : "error");
    setBusy(false);
  };
  return (
    <View className="gap-2 px-4">
      <AppTextInput
        accessibilityLabel={gt("Trusted Noise pairing link")}
        placeholder="t3noise://pair#…"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        value={value}
        onChangeText={(text) => {
          setValue(text);
          setResult(null);
        }}
      />
      <ListRow
        label={
          result === "changed"
            ? gt("Use the new host key")
            : gt("Connect with end-to-end encryption")
        }
        description={gt(
          "Paste the link from t3 auth connect-device noise-pin on the host to encrypt chat, attachments, workspace files, and terminal sessions.",
        )}
        disabled={!pin || busy}
        onPress={() => void submit()}
      />
      {result && (
        <AppText accessibilityLiveRegion="polite">
          {result === "changed"
            ? gt(
                "The host key changed. Verify the new link on the host before replacing its saved key.",
              )
            : result === "error"
              ? gt("Could not enable the encrypted connection.")
              : gt(
                  "Check the environment’s connection status below. If it shows a code, compare it on the host and approve this device.",
                )}
        </AppText>
      )}
    </View>
  );
}
