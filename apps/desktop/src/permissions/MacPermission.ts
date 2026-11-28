import { msg } from "gt-i18n";

export const MAC_PERMISSION_SETTINGS_URLS = {
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
};

export type MacPermission = keyof typeof MAC_PERMISSION_SETTINGS_URLS;

export const MAC_PERMISSION_SETUP_TITLES: Record<MacPermission, string> = {
  "full-disk-access": msg("Set up Full Disk Access"),
};
