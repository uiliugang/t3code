import { describe } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-ui-translation", {
  filename: "apps/web/src/components/cloud/ConnectOnboardingDialog.tsx",
});

describe("t3code/require-ui-translation", () => {
  rule.valid(
    "preserves user content and code while translating UI copy",
    `
    const node = <div title={t("Approve this device?")}>
      {project.title}<code>t3 connect</code>{t("Waiting for {environment} to approve this device", { environment: name })}
    </div>;
  `,
  );
  rule.valid(
    "keeps layout and routes out of product copy",
    `
    const node = <input className="text-muted-foreground" value="user data" placeholder={t("Search")} />;
  `,
  );
  rule.valid(
    "accepts the official translation component including rich text and translation context",
    `
    import { T as Localized } from "gt-react";
    const node = <Localized context="a setting">Update <b>available</b>.</Localized>;
  `,
  );
  rule.invalid(
    "rejects an untranslated attribute on markup inside an official translation",
    `
    import { T } from "gt-react-native";
    const node = <T><Text aria-label="More options">Options</Text></T>;
  `,
  );
  rule.invalid(
    "rejects untranslated copy in an unrelated component named T",
    `
    import { T } from "./Table";
    const node = <T>Settings</T>;
  `,
  );
  rule.invalid(
    "rejects the device approval copy omitted in d392444",
    `
    const node = <OnboardingToggleRow title="Require approval for new devices"
      description="Devices that sign in to your T3 Connect account wait until someone already connected here approves them." />;
  `,
  );
  rule.invalid(
    "rejects the sign-in retry copy omitted in d392444",
    `
    const node = <span>Retry T3 Connect</span>;
  `,
  );
  rule.invalid(
    "rejects untranslated onboarding notifications",
    `
    toastManager.add({ title: "T3 Connect enabled" });
  `,
  );
  rule.invalid(
    "rejects a count interpolated before looking up its translation",
    `
    const label = t(\`Waiting on \${count} subagents\`);
  `,
  );
  rule.invalid(
    "rejects a literal translation key absent from the catalog",
    `
    const node = <p>{t("Untranslated new feature")}</p>;
  `,
  );
});
