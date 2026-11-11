import type { APIRoute } from "astro";

import { ANDROID_PLAY_STORE_URL, GITHUB_REPOSITORY_URL, IOS_APP_STORE_URL } from "../lib/site";
import { GITHUB_REPOSITORY, INSTALL_SCRIPTS_URL } from "../lib/repository";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index of this fork's downloads and the upstream services.
export const GET: APIRoute = () => {
  const body = `# T3 Code

> ${SITE_TAGLINE}. T3 Code is free, MIT-licensed, and built by T3 Tools Inc. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents from one desktop, web, and mobile app.

This site distributes the ${GITHUB_REPOSITORY} fork. Desktop and CLI builds come from ${GITHUB_REPOSITORY_URL}/releases. The upstream project is at https://t3.codes; its hosted web app, iOS App Store app, and Google Play app are upstream services.

## Links

- [Download T3 Code](${absoluteUrl("/download")}): macOS, Windows, and Linux installers
- [Web app](https://app.t3.codes): connect to a T3 Code server from a browser
- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): release builds and changelogs
- [Unix CLI installer](${INSTALL_SCRIPTS_URL}/install.sh)
- [Windows CLI installer](${INSTALL_SCRIPTS_URL}/install.ps1)
- [iOS app](${IOS_APP_STORE_URL})
- [Android app](${ANDROID_PLAY_STORE_URL})

## Policies

- [Security policy](${absoluteUrl("/security-policy")})
- [Privacy policy](${absoluteUrl("/privacy-policy")})
- [Terms of service](${absoluteUrl("/terms-of-service")})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
