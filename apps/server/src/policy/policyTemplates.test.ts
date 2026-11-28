import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { macosProfile } from "./policyTemplates.ts";

it("refuses a profile for a policy with a null value, which a plist cannot hold", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: { defaultModelSelection: { value: null, locked: true } },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.deepStrictEqual(profile, {
    _tag: "Invalid",
    reason:
      "settings.defaultModelSelection is null, which a configuration profile cannot hold; deploy this policy as a file.",
  });
});

it("keeps carriage returns in the macOS profile's provider environment strings", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      limits: {
        providers: {
          instances: {
            [ProviderDriverKind.make("claudeAgent")]: {
              locked: true,
              environment: [{ name: "EXAMPLE_PAYLOAD", value: "first\r\nsecond\rthird\n<&>" }],
            },
          },
        },
      },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert(profile._tag === "Valid");
  assert.include(profile.profile, "<string>first&#13;\nsecond&#13;third\n&lt;&amp;&gt;</string>");
});
