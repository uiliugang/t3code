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
