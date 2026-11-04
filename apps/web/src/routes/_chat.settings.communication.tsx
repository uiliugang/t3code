import { createFileRoute } from "@tanstack/react-router";
import { CommunicationSettings } from "../components/settings/CommunicationSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function CommunicationPage() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <CommunicationSettings environments={connectedEnvironments} />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/communication")({
  component: CommunicationPage,
});
