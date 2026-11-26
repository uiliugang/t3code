# Release Runbook

## Personal fork releases

`uiliugang/t3code` uses `.github/workflows/fork-release.yml`. Enable GitHub Actions in
the fork and configure these repository secrets with one persistent Android release key:
`ANDROID_KEYSTORE_BASE64` (base64-encoded keystore), `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Back up the keystore and passwords;
replacing the key prevents installed APKs from upgrading in place.

Run **Fork macOS Linux and Android release** manually on a branch to validate the build and
download its Actions artifacts. Push a plain `vX.Y.Z` tag to publish one GitHub Release
after all builds pass. The manual Actions entry becomes available once the workflow is
merged into the default branch. Pushes to `main` that match the workflow's path filters
run Android cache warmup after a five-minute quiet window. Each new matching push
cancels the older run and restarts the wait. Tags and manual builds skip the wait.
Pull requests do not trigger this workflow. Tags with prerelease suffixes are rejected. The workflow builds
an Apple Silicon arm64 DMG, Linux x64/arm64 AppImages and Debian packages, self-contained CLI runtime
archives, and a standalone, signed ARM64 Android APK, with `SHA256SUMS` covering
every asset. CLI archives cover macOS arm64 and Linux x64/arm64. This fork's clients,
CLI installers, and npm launcher download runtimes from `uiliugang/t3code`,
independently of desktop update settings. Use a tagged release for SSH connections:
manual branch builds have temporary versions with no matching published runtime.
Android uses `com.uiliugang.t3code`. Its versionCode is
`101000000 + major * 1000000 + minor * 1000 + patch`, with major at most 1998
and minor/patch at most 999. Historical `0.0.0` through `0.0.18` and the misnumbered
`0.1.9` retain the old base of `100000000`. The corrected `0.0.19` sequence can thus
upgrade both `0.0.18` and `0.1.9` without uninstalling. Do not reuse `0.1.9` for a new
release. Rebuilding the same version keeps the same versionCode;
bump the release version to distribute a binary correction. Manual branch builds
use the source version without its prerelease suffix for this calculation.

The fork release sequence is `0.0.17`, corrected `0.0.18`, then `0.0.19`.
Retain the misnumbered `v0.1.9` tag and its assets as historical evidence, but mark
its GitHub Release as a prerelease so stable-release discovery excludes it. After
publishing `v0.0.19`, explicitly select it as GitHub's latest release; the old
`v0.0.18` workflow uses semantic version ordering. Existing `0.1.9` desktop and CLI
installs need one manual installation of `0.0.19`, because their updater sees the
corrected number as a downgrade. Do not bypass this by changing signed metadata
or renaming the old binaries.

The macOS app is ad hoc signed without Apple notarization, so Gatekeeper can require
approval in System Settings. It has no automatic update feed: Settings → About →
Check for Updates reads this fork's GitHub Releases and offers its installer. Linux
AppImages and Debian packages update in the app using the `latest-linux*.yml` files published beside them. Existing builds
with updates disabled need one manual install of a release containing this change.
Release stamping preserves the source version for provider compatibility checks;
the fork's independent version numbers must not select upstream protocol policies.
Android disables the upstream Expo OTA feed and bundles its JavaScript; it needs no Metro server, Expo account,
or Google Play publishing credentials. Fork releases use the official T3 Connect public configuration
and [Firebase client resources](../../.github/config/google-services.fork.json), reconstructed from
the [official Android 2.3.0 (801) APK](https://github.com/pingdotgg/t3code/releases/tag/v0.1.11-nightly.20261117.4838).
The Firebase app ID remains upstream's; the build-time package selector matches `com.uiliugang.t3code`
so the fork retains its install and update identity. This file contains no service-account private key.
Upstream Firebase and Connect policy still controls access; obtaining an FCM token does not verify
end-to-end delivery. These builds do not provision a private relay or fork-specific cloud authentication.

The stable product name is T3 Code. The release channels remain stable and nightly.

## Upstream release workflow

Unified release workflow: `.github/workflows/release.yml`. Beta is a product label, not a release channel—channels remain `stable` and `nightly` (plus `preview` for maintainer test builds).

## Channels and triggers

- **Stable (`channel=stable` on `main`, or pushing a `vX.Y.Z` tag):** Manual dispatch promotes the **latest published nightly commit** (not `main` HEAD) using its base version unless overridden. Pushing a `vX.Y.Z` tag ships that exact commit. Finalization commits version bumps to `main` using `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`.
- **Nightly (scheduled every 30 min when new commits exist and >=6 h elapsed, or manual `channel=nightly` on `main`):** Publishes a GitHub prerelease, `nightly` desktop updater channel, `nightly` npm dist-tag, hosted `nightly` web alias, and marketing site. Does not bump versions on `main`.
  - Pause/resume automatic nightlies: `gh variable set PAUSE_NIGHTLY -b true -R pingdotgg/t3code` / `gh variable delete PAUSE_NIGHTLY -R pingdotgg/t3code`.
- **Preview (`channel=preview`, any branch—default dispatch channel):** Exercises build, signing, notarization, and smoke tests into a **draft** GitHub release and skips npm, web, AUR, and announcements. **Never publish a preview draft or push a test tag**—there is no dry-run tag path (any non-nightly `v*` tag publishes stable), and published preview tags hide nightlies from the update feed. Rebase onto `main` before dispatching `preview`.
- **PR macOS previews:** Applying the `preview:mac` label triggers a two-workflow split (`desktop-macos-preview.yml` builds the untrusted JS bundle; `desktop-macos-preview-publish.yml` checks author trust against `main`'s `.github/VOUCHED.td`, packages/signs using `main`, and publishes to rolling `desktop-preview`). One-shot per commit; label is removed automatically.

## Critical release invariants

- **Server self-update ordering:** Connected servers update to the exact client version by downloading the GitHub Release CLI archive (or `npx t3@<version>`). Keep the release graph order strictly: `release` (CLI archives + `SHA256SUMS` + desktop installers) → `publish_cli` (`t3` npm launcher) → `deploy_web` (hosted channel alias). Never publish clients before the archives and npm launcher exist.
- **Standalone CLI archives & Node pin:** `engines.node` in root `package.json` must stay exact (Node SEA builds reject mismatches). There is no macOS x64 CLI archive (SEA is unsupported there; x64 desktop uses Electron).
- **Smoke fixture:** `scripts/fixtures/desktop-launch` is intentionally an old SQLite snapshot to verify forward migrations on packaged builds—never regenerate it on schema changes.
- **Hosted web & marketing:** Vercel Git auto-deployments stay disabled (`apps/{web,marketing}/vercel.ts`). Releases build with `--skip-domain` and alias `app.t3.codes` / `latest.app.t3.codes` (stable) or `nightly.app.t3.codes` + marketing (nightly) only after publication.

## Update feed

Nightly installs check `releases.atom` (the 10 newest git tags), then the `update-feed` release's `nightly.json` pointer, then the GitHub API as fallback. **Never delete the `update-feed` release.**

- If `Check the update feed` fails because stray/preview tags pushed the newest nightly out of `releases.atom`, delete the unneeded tags (`git push origin :refs/tags/<tag>`—converting a release to draft keeps its tag).
- **To pull a bad nightly:** delete its release and tag, run `gh release delete-asset update-feed nightly.json` (so installs fall back until the next tick rewrites it), and move npm's `nightly` dist-tag back with `npm dist-tag add t3@<last-good> nightly`.

## T3 Connect relay deployment

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. See [infra/relay/README.md](../../infra/relay/README.md#deployment-ci) for required variables/secrets. Keep `.env.example` in sync with `production` public identifiers so preview builds work off non-`main` branches. After editing a secret/variable, manually run **Deploy T3 Connect relay** (with `force` unchecked).

Labeling a same-repo PR `relay:preview` deploys stage `pr-<number>` (cleaned up on unlabel/close).

### Managed tunnel cleanup rollout

`RELAY_TUNNEL_CLEANUP_MODE` and `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` accept `off` (default), `dry-run`, or `enabled` and take effect on the next relay deploy (without `force`). Monitor `relay.managed_endpoint_reaper.sweep` spans in Axiom. To stop cleanup during an incident, set the mode to `off` and redeploy the relay.

## Mobile releases

- **iOS TestFlight / App Store:** Merges to `main` publish compatible OTAs and build TestFlight prereleases (`testflight` profile at `3.0.0`). To cut an App Store build, dispatch **Mobile EAS Production** (`mode=build`, `profile=production`, `platform=ios`, explicit version). Before shipping `3.0.0` to the App Store, advance `build.testflight.env.T3CODE_MOBILE_VERSION` in `apps/mobile/eas.json` to the next unreleased major.
- **Android APK mirror:** `.github/workflows/mobile-android-apk.yml` polls Google Play Alpha hourly and mirrors new Play-signed universal APKs to `android-beta-<build-number>` prereleases (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`). Nightlies attach the latest internal-testing APK when available.

## Windows payload topology and update validation

Windows packages the bundled server and its unpacked native modules in `resources/server.asar` (+ `server.asar.unpacked`) and embeds the matching-architecture Linux CLI archive as `resources/wsl-runtime.tar.gz` + SHA-256 sidecar (passed via `--wsl-runtime`). Avoid whole-package smart unpacking (keeps unpacked file counts and NSIS differential blockmaps bounded). `scripts/build-desktop-artifact.ts` enforces all structural, native-load, and WSL archive checks at build time.

## One-time credentials setup

### npm OIDC trusted publishing

Configure `t3` on npm with GitHub Actions Trusted Publishing for `.github/workflows/release.yml` (the workflow publishes only the `t3` launcher tarball via `npm publish --provenance`). Set the publisher's environment to `production`, which `publish_cli` declares.

### Apple signing and notarization (macOS)

- **Secrets:** `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (raw `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE` (base64 profile for `com.t3tools.t3code` with Associated Domains).
- **Variables:** `APPLE_TEAM_ID`, optional `CLERK_PASSKEY_RP_DOMAINS`.
- The packager only enables passkey entitlements (`keychain-access-groups`, `com.apple.developer.web-browser.public-key-credential`) present in the provisioning profile; regenerate and re-upload `MACOS_PROVISIONING_PROFILE` after Apple approves managed capabilities. Complete Clerk AASA setup per [Connect setup](./02_connect-setup.md#desktop-passkeys).

### Azure Trusted Signing (Windows)

Set secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` with an Entra service principal granted Trusted Signing permissions.

## Ongoing stable release checklist

1. Verify the latest nightly (desktop launch, `npm view t3@<version> version`, remote server update + DB migration smoke test).
2. Dispatch **Release** on `main` with `channel=stable` (leave `version` blank unless overriding the nightly's base version).
3. Confirm `Resolve release commit` matches the verified nightly, then verify `release` → `publish_cli` → `deploy_web` all succeed.
4. Smoke-test the published artifacts.
