import type { ManagedPolicyDocument } from "@t3tools/contracts";
const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    // XML parsers can normalize literal carriage returns before decoding text.
    .replaceAll("\r", "&#13;");

const plistValue = (value: unknown, indent: string): string => {
  const inner = `${indent}  `;
  if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value} />`;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${indent}<integer>${value}</integer>`
      : `${indent}<real>${value}</real>`;
  }
  if (Array.isArray(value)) {
    return `${indent}<array>\n${value.map((item) => plistValue(item, inner)).join("\n")}\n${indent}</array>`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return `${indent}<dict>\n${entries
    .map(([key, item]) => `${inner}<key>${escapeXml(key)}</key>\n${plistValue(item, inner)}`)
    .join("\n")}\n${indent}</dict>`;
};

/** Where `value` holds a `null`, as path segments, or undefined when it holds none. */
const nullPath = (
  value: unknown,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  if (value === null) return path;
  if (typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const found = nullPath(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** A device configuration profile that installs `document` for `com.t3tools.t3code`. */
export function macosProfile(
  document: ManagedPolicyDocument,
  uuids: { readonly profile: string; readonly payload: string },
):
  | { readonly _tag: "Valid"; readonly profile: string }
  | { readonly _tag: "Invalid"; readonly reason: string } {
  // A plist has no null, and a setting may be locked empty.
  const empty = nullPath(document, []);
  if (empty !== undefined) {
    const setting =
      empty[0] === "settings" && empty.at(-1) === "value" ? empty.slice(0, -1) : empty;
    return {
      _tag: "Invalid",
      reason: `${setting.join(".")} is null, which a configuration profile cannot hold; deploy this policy as a file.`,
    };
  }
  const profile = {
    PayloadContent: [
      {
        PayloadDisplayName: "T3 Code policy",
        PayloadIdentifier: `com.t3tools.t3code.policy.${uuids.payload}`,
        PayloadType: "com.t3tools.t3code",
        PayloadUUID: uuids.payload,
        PayloadVersion: 1,
        ...document,
      },
    ],
    PayloadDescription: "Configures T3 Code for every user on this Mac.",
    PayloadDisplayName: `T3 Code policy for ${document.organization}`,
    PayloadIdentifier: `com.t3tools.t3code.policy`,
    PayloadOrganization: document.organization,
    PayloadScope: "System",
    PayloadType: "Configuration",
    PayloadUUID: uuids.profile,
    PayloadVersion: 1,
  };
  return {
    _tag: "Valid",
    profile: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(profile, "")}
</plist>
`,
  };
}
