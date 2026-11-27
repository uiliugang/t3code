import { useUiTranslation } from "~/hooks/useUiTranslation";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { useAuth } from "@clerk/react";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import {
  DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT,
  MAX_WORKFLOW_SKIPPED_RUNS_KEPT,
} from "@t3tools/contracts";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { commitNumberFieldOnEnter } from "./commitNumberFieldOnEnter";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { firstManagedDenial, usePrimaryManagedPolicy } from "~/state/managedPolicy";

/** Features still settling in. */
export function LabsSettingsPanel() {
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title={gt("Beta")}>
        {/* Clerk is only mounted when this build has T3 Connect. */}
        {hasCloudPublicConfig() ? <GuestLinksRowWithSignIn /> : <GuestLinksRow />}
        <WorkflowsRow />
        <WorkflowSkippedRunsRow />
        <SimlockHostsRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** Signed out of T3 Connect, the row offers to sign in instead of its switch. */
function GuestLinksRowWithSignIn() {
  const t = useUiTranslation();
  const searchableSetting = useSearchableSetting();
  const { isSignedIn } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // `isSignedIn` is undefined until Clerk loads.
  if (isSignedIn !== false) return <GuestLinksRow />;
  return (
    <SettingsRow
      {...searchableSetting("guest-links")}
      description={t(
        "Share a thread with a guest who watches it live in their browser and sends messages you approve. Sign in to T3 Connect to use guest links.",
      )}
      control={
        <Button size="sm" variant="outline" onClick={openAuthPrompt}>
          {t("Sign in")}
        </Button>
      }
    />
  );
}

function GuestLinksRow() {
  const t = useUiTranslation();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const messages = useMessages();
  const scope = useOptionalSettingsScope();
  const primaryPolicy = usePrimaryManagedPolicy();
  // Guests arrive through T3 Connect, so a policy that turns Connect off turns this off too.
  const connectDenial = firstManagedDenial(
    scope
      ? scope.connectedEnvironments.map((environment) => environment.serverConfig?.managedPolicy)
      : [primaryPolicy],
    (policy) => managedCapabilityDenial(policy, "connect", messages),
  );
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("guest-links")}
      settingKeys={["guestSharingEnabled"]}
      // Turning guest links off still works without T3 Connect.
      managed={settings.guestSharingEnabled ? undefined : connectDenial}
      description={
        <>
          {t(
            "Share a thread with a guest who watches it live in a browser and sends messages you approve. Needs T3 Connect: sign in and link this machine in",
          )}{" "}
          <Link to="/settings/access" className="underline underline-offset-2">
            {t("Sharing & access")}
          </Link>
          {t(". Turning it off stops every guest link.")}
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label={t("Guest links")}
        />
      }
    />
  );
}

function WorkflowsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflows-beta")}
      settingKeys={["workflowsEnabled"]}
      description={gt(
        "Run multi-step workflows from files in the workflows folder of this server's T3 home. Open them from the command palette. While off, nothing in that folder runs; runs wait until it is on again.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["workflowsEnabled"]}
          checked={settings.workflowsEnabled}
          onCheckedChange={(checked) => updateSettings({ workflowsEnabled: Boolean(checked) })}
          aria-label={gt("Workflows")}
        />
      }
    />
  );
}

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

export function WorkflowSkippedRunsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["workflowSkippedRunsKept"]);
  const gt = useGT();
  if (!settings.workflowsEnabled) return null;
  const kept = settings.workflowSkippedRunsKept;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflow-skipped-runs")}
      settingKeys={["workflowSkippedRunsKept"]}
      description={gt(
        "How many skipped runs each workflow keeps in its history. Older skipped runs are deleted; runs that did something are always kept.",
      )}
      resetAction={
        mixed || kept !== DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT ? (
          <SettingResetButton
            ariaLabel={gt("Reset skipped runs kept to default")}
            onClick={() =>
              updateSettings({ workflowSkippedRunsKept: DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT })
            }
          />
        ) : null
      }
      control={
        <div className="w-24">
          <NumberField
            value={mixed ? null : kept}
            min={0}
            max={MAX_WORKFLOW_SKIPPED_RUNS_KEPT}
            format={NO_GROUPING}
            size="sm"
            onValueCommitted={(value) => {
              if (value === null || !Number.isInteger(value) || (!mixed && value === kept)) return;
              updateSettings({ workflowSkippedRunsKept: value });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldInput
                aria-label={gt("Skipped runs kept")}
                placeholder={mixed ? gt("Mixed") : undefined}
                onKeyDown={commitNumberFieldOnEnter}
              />
            </NumberFieldGroup>
          </NumberField>
        </div>
      }
    />
  );
}

function SimlockHostsRow() {
  const t = useUiTranslation();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <>
          {t("Let the Device panel lease simulators and emulators from your own")}{" "}
          <a
            href="https://incubator.callstack.com/simlock/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          {t("pool, added in")}{" "}
          <Link to="/settings/devices" className="underline underline-offset-2">
            {t("Devices")}
          </Link>
          {t(". An alpha that may change or break. T3 Code never installs Simlock.")}
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label={t("Simlock device hosts")}
        />
      }
    />
  );
}
