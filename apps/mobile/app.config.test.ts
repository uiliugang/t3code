import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ ...process.env }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("configures a standalone Android release without upstream OTA", async () => {
  vi.stubEnv("T3CODE_ANDROID_PACKAGE", "com.uiliugang.t3code");
  vi.stubEnv("T3CODE_ANDROID_VERSION_CODE", "42");
  vi.stubEnv("T3CODE_MOBILE_VERSION", "1.2.3");
  vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", "0");
  const config = await loadConfig("production");
  expect(config.android?.package).toBe("com.uiliugang.t3code");
  expect(config.android?.versionCode).toBe(42);
  expect(config.version).toBe("1.2.3");
  expect(config.updates?.enabled).toBe(false);
  expect(config.android?.blockedPermissions).toContain(
    "android.permission.REQUEST_INSTALL_PACKAGES",
  );
});

it("enables APK installation only in builds configured with an update source", async () => {
  vi.stubEnv("T3CODE_ANDROID_APK_UPDATE_URL", "https://example.com/android-update.json");
  const config = await loadConfig("production");
  expect(config.extra?.androidApkUpdateUrl).toBe("https://example.com/android-update.json");
  expect(config.android?.permissions).toContain("android.permission.REQUEST_INSTALL_PACKAGES");
  expect(config.android?.blockedPermissions).not.toContain(
    "android.permission.REQUEST_INSTALL_PACKAGES",
  );
});

it.each(["http://example.com/update.json", "https://user:password@example.com/update.json"])(
  "rejects an unsafe APK update source: %s",
  async (url) => {
    vi.stubEnv("T3CODE_ANDROID_APK_UPDATE_URL", url);
    await expect(loadConfig("production")).rejects.toThrow(
      "must be an HTTPS URL without credentials",
    );
  },
);

it.each(["0", "1.5", "NaN", "2100000001"])("rejects Android versionCode=%s", async (value) => {
  vi.stubEnv("T3CODE_ANDROID_VERSION_CODE", value);
  await expect(loadConfig("production")).rejects.toThrow("T3CODE_ANDROID_VERSION_CODE must be");
});
