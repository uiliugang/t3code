import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SECURITY_POLICY_URL, TERMS_OF_SERVICE_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen({
  route,
}: StaticScreenProps<{ document: "terms" | "security" } | undefined>) {
  const gt = useGT();
  const navigation = useNavigation();
  const terms = gt("Terms of service");
  const security = gt("Security policy");
  const document = route.params?.document;
  if (document === "terms" || document === "security") {
    return (
      <SettingsLegalDocumentRouteScreen
        documentName={document === "terms" ? terms : security}
        documentUrl={document === "terms" ? TERMS_OF_SERVICE_URL : SECURITY_POLICY_URL}
      />
    );
  }

  return (
    <>
      <SheetHeader
        title={gt("Legal", { $context: "legal documents page title" })}
        onClose={() => navigation.goBack()}
      />
      <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="p-5">
        <SettingsSection>
          <ListRow
            label={terms}
            onPress={() =>
              navigation.dispatch(StackActions.push("SettingsLegal", { document: "terms" }))
            }
          />
          <ListRow
            label={security}
            onPress={() =>
              navigation.dispatch(StackActions.push("SettingsLegal", { document: "security" }))
            }
          />
        </SettingsSection>
      </ScreenScrollView>
    </>
  );
}
