import { expect, it } from "vite-plus/test";

import { detectPlatform, getPlatformAppUrl } from "./platform";
import { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL, WEB_APP_URL } from "./site";

it.each([
  {
    // Android user agents also contain "Linux".
    name: "Android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    maxTouchPoints: 5,
    os: "android",
    appUrl: ANDROID_PLAY_STORE_URL,
  },
  {
    name: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    os: "ios",
    appUrl: IOS_APP_STORE_URL,
  },
  {
    // iPad Safari sends a desktop Mac user agent by default.
    name: "iPad with a desktop user agent",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    maxTouchPoints: 5,
    os: "ios",
    appUrl: IOS_APP_STORE_URL,
  },
  {
    name: "Windows browser",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    os: "win",
    appUrl: WEB_APP_URL,
  },
  {
    name: "Linux",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    os: "linux",
    appUrl: null,
  },
  {
    name: "macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    maxTouchPoints: 0,
    os: "mac",
    appUrl: null,
  },
])("$name visitors use the $os app entry", ({ userAgent, maxTouchPoints, os, appUrl }) => {
  const platform = detectPlatform(userAgent, maxTouchPoints);
  expect(platform?.os).toBe(os);
  expect(platform && getPlatformAppUrl(platform)).toBe(appUrl);
});
