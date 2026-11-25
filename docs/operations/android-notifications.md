# Android notifications

Firebase Cloud Messaging (FCM) wakes Android when activity changes. Each data message contains only `t3_kind=agent_activity_wake`, `environment_id`, `device_id`, and `user_id`. The phone checks the signed-in account and preferences, opens its approved Noise connection to the host, and builds notifications from the returned activity.

## Android compatibility and automated checks

The app's minimum is Android 7.0 (API 24), declared in `app.config.ts` and enforced by the relay's device-registration schema. Compile/target SDK versions follow the locked Expo/React Native toolchain (currently API 36). Notification channels begin at API 26; the notification permission prompt begins at API 33. Live Update promotion requires API 36 and remains subject to system settings and device support. Alerts and ordinary activity cards work below API 36.

On Android 16+, open T3 Code Settings → Live Update Settings to allow status bar chips. Android controls this separately from notification permission. The chip reads `Working` during work, `Approve` for approvals, and `Answer` for input requests; completed work returns to a normal notification. Use an Android 16 QPR2 or newer emulator image to verify the shipped promotion behavior.

API 24–25 use a single inexact system alarm to expire cards after process exit, with no exact-alarm permission. Android can delay that alarm in power-saving modes. API 26+ use notification timeouts. Disabling activity, dismissal, account changes and sign-out cancel the legacy alarm. A stale expiry broadcast cannot remove a newer run's card.

The native notification tests cover API 24, 26, 33 and 36 (plus API 25 for legacy expiry) using Robolectric. To compile the module, run these tests and run Android lint, use the following command from a generated `apps/mobile/android` project with JDK 21 available. No Firebase, signing or relay secrets are required:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest :t3-agent-notifications:lintRelease -Pandroid.lint.useK2Uast=false
```

Robolectric's API 36 runtime requires JDK 21; module compilation still uses Expo's Java 17 toolchain. The existing Mobile Native Static Analysis job separately runs ktlint and detekt. The native fingerprint check marks this change as requiring a new binary; the production workflow cannot deliver it to an older binary by OTA. Settings disable Android notifications if the installed native module is missing required methods.

The lint command uses the K1 frontend because AGP's K2 frontend crashes while analyzing Worklets 0.10's Gradle Kotlin scripts. This does not disable lint checks. Live Update eligibility must be verified on a device: Robolectric's API 36 image implements older promotion rules that require colorization, while shipped Live Updates require uncolorized notifications.

## Firebase and app build

1. Create a Firebase project and register each Android application identifier you intend to build: `com.t3tools.t3code.dev`, `com.t3tools.t3code.preview`, or `com.t3tools.t3code`.
2. Download `google-services.json`. Set `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` to its path when running Expo prebuild and building the app. The JSON must contain the selected variant's package identifier.
3. Create a service-account key with permission to send FCM messages for that Firebase project. Keep this private JSON outside the repository and the app bundle.
4. Enable the Firebase Cloud Messaging API in the Google project if it is not already enabled. For hosted delivery, set the relay's `FCM_SERVICE_ACCOUNT` secret to the service-account JSON.
5. Build a new Android binary. A JavaScript-only update cannot install the native notification handler or Firebase configuration. Hosted delivery also needs the relay database migration and updated relay deployment; local verification can use the watcher below.

For a local development build, set the public relay and Clerk values for your test deployment in the build environment. From `apps/mobile` run

```sh
APP_VARIANT=development \
T3CODE_RELAY_URL=https://your-relay.example \
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=your-publishable-key \
T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/absolute/path/google-services.json \
vp run android:dev
```

For an EAS build, provide the same configuration through each selected build environment, using an EAS file variable named `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` for the Google services file. Make the file available to fingerprint generation as well as the native build. FCM service-account credentials belong on the relay, not in EAS's app environment. If deploying a separate hosted relay, configure the build's T3 Connect public settings for that relay and Clerk application as described in [T3 Connect](../internals/t3-connect.md).

Set `T3CODE_MOBILE_UPDATES_ENABLED=0` before prebuild and bundling a private binary to disable the repository's configured Expo OTA update source. A debug development-client APK requires Metro; a bundled release build is needed to verify cold-start notification taps without Expo's development launcher.

## Clerk sign-in for private builds

Clerk's native Android sign-in uses `clerk://<applicationId>.callback`. In the Clerk instance selected by the build's publishable key, its administrator must allow the exact callback under **Native applications > Allowlist for mobile SSO redirect**. For the development package, add:

```text
clerk://com.t3tools.t3code.dev.callback
```

The app already declares the matching callback receiver. A "redirect url ... does not match an authorized redirect URI" error requires a Clerk configuration change; rebuilding the same APK does not fix it. Reopen sign-in after the administrator saves the entry. See [Android native sign-in redirects](./connect-setup.md#android-native-sign-in-redirects) for the other variants.

Using T3's existing production publishable key selects the maintainers' Clerk instance. It grants no access to change that instance's allowlist. The chosen package's callback must already be allowed or be added by that instance's administrator. Android device registration and hosted delivery separately require the relay deployment below. A successful direct-pairing or FCM smoke test does not verify hosted sign-in or device registration.

Building with `APP_VARIANT=production` selects `com.t3tools.t3code` and its corresponding Clerk callback. Set the same variant during prebuild and bundling, and supply a Google services file that includes that package. Keep OTA updates disabled for a private binary. A locally signed build with this package cannot update an official installation signed by the maintainer or coexist with it; removing that installation also removes its app-local data. The development package remains a separate app.

## Focused delivery check

Keep the fork host online with activity publishing and T3 Connect remote access enabled. A publish-only link has no tunnel for the phone to fetch details. Sign in to the matching Clerk account in an APK built for that relay, register the Android device and enable notifications for the environment. Pair the Android device using the host's Noise pin and approve its displayed code. Open the environment from the phone once to verify the connection. [Android Noise pairing](../user/remote-access.md#use-an-end-to-end-encrypted-connection-on-android)

Place the app's FCM `token`, `packageName`, registered `deviceId`, signed-in `userId`, and the target `environmentId` in a private device JSON file. From `infra/relay` run

```sh
vp run push:android:smoke /path/service-account.json /path/device.json
```

The command sends one wake through the production FCM client. Fields such as `deepLink` in an older device file are ignored. Update older files with the host's environment ID and remove the old phase argument from command lines.

To verify the full path, leave a local Replay thread waiting for approval, background the Android app, and send a wake. Check the project and thread shown on the phone and tap the notification to open that thread. Repeating the wake for an unchanged request should leave a single alert. Firebase acceptance confirms only that Firebase accepted the wake. The host supplies the current state at fetch time, and Android delivery can be delayed. An unreachable host or a revoked device cannot supply details.

Check a completed run and an empty environment to verify card expiry and removal. Also test foreground thread suppression, dismissal, sign-out, and delivery after process exit. Android's **Force stop** setting prevents delivery until the app is opened again.

After Android prebuild, run the native presentation regression tests from `apps/mobile/android`:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest --tests expo.modules.t3agentnotifications.AgentNotificationsTest
```

## Relay deployment

### Local verification with existing T3 services

The local watcher can send wakes when a paired host changes. Use the host’s loopback WebSocket URL or a trusted direct connection. The watcher authenticates with a bearer token and its shell subscription carries readable project and thread details, so a relay or proxy on that path could read them. It batches changes into the same environment wake as the smoke command. Production Android notifications fetch their details over Noise.

Create a private `connection.json` containing `wsUrl` (the host's `/ws` URL) and `bearerToken` (a separate paired credential). Use the device JSON and phone setup from the focused delivery check. The watcher verifies that the host's ID matches `environmentId` in that file. From `infra/relay` run

```sh
vp run push:android:watch /path/service-account.json /path/device.json /path/connection.json
```

Keep the watcher running while changing a thread on the host. The phone still uses its saved T3 Connect environment and Noise approval to read the latest activity.

### Hosted delivery

The existing Alchemy deployment provisions Cloudflare Workers, delivery queues, Hyperdrive, tunnel/DNS resources, PlanetScale Postgres, and Axiom observability by default. It requires credentials for the enabled services and private Clerk configuration; the repository's public app settings do not grant deployment access. Set `APNS_ENABLED=false` in an Android-only development relay to skip Apple delivery and its credential requirements. APNs remains enabled by default.

#### Personal stage in the existing deployment accounts

A maintainer with access to the existing Alchemy state and deployment credentials can deploy the Android changes to a personal stage. Non-production stages reference the retained database and DNS zones owned by the `prod` stage, create a separate PlanetScale branch, and apply migrations to that branch. A personal stage is therefore not a standalone deployment into an unrelated account.

1. Apply the Android changes to a checkout with the existing deployment credentials. Create a private `infra/relay/.env.android-dev` using the existing Cloudflare, PlanetScale, Axiom, domain, and Clerk configuration described in the [relay README](../../infra/relay/README.md#deployment-ci). Keep `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_JWT_AUDIENCE` on the same Clerk instance used by the test clients.
2. Add the Firebase service-account JSON as `FCM_SERVICE_ACCOUNT` and set `APNS_ENABLED=false` for this Android-only stage. Leave `RELAY_DOMAIN` unset so the deployment derives a hostname for the personal stage instead of using the production hostname.
3. From the repository root, inspect the deployment plan, then deploy the same stage:

   ```sh
   vp run --filter t3code-relay deploy --stage dev_ryan_android --env-file .env.android-dev --dry-run
   vp run --filter t3code-relay deploy --stage dev_ryan_android --env-file .env.android-dev
   ```

4. Give the tester the deployed relay URL and matching public Clerk configuration. The deploy wrapper also writes the relay URL and public tracing configuration into that checkout's root `.env`. Rebuild the private APK with this `T3CODE_RELAY_URL`, the existing Firebase Android file, and OTA updates disabled. If using the separate development package, authorize its Clerk callback as described above.
5. Configure one isolated T3 server with the same relay URL and link that test environment through the new relay. Existing production relay links do not automatically move to a personal stage. Enable activity publishing and remote access, approve the phone's Noise pairing request, and verify that a local Replay turn updates the notification while the phone is locked.

The maintainer can perform deployment themselves and return only the public client configuration; the tester does not need copies of their hosting or Clerk server credentials. A fully independent deployment needs its own initial Cloudflare stack, PostgreSQL database, Firebase project, and a Clerk instance the operator can configure. Its Alchemy deployment needs PlanetScale and Axiom credentials.

Build the host client and mobile app with the same relay URL and Clerk public configuration. A source server or desktop development build can host the test environment; keep its T3 home separate from an existing installation. Signing into the phone alone does not link a host environment. Use the host client's T3 Connect settings to link it and enable activity publishing. A private Clerk instance also needs its own CLI OAuth application before using `t3 connect login`; the repository's production CLI client ID belongs to the maintainers' instance.

For deployment through GitHub Actions, add `FCM_SERVICE_ACCOUNT` to the `production` environment's secrets. The relay workflow passes it to Alchemy. The maintainer must also supply `google-services.json` for the production Android package in the native build environment; changing the relay secret alone cannot move an installed app to another Firebase project.

The fork host signs an environment wake when activity changes. The relay checks the linked accounts, registered devices, and notification preferences before sending FCM wakes. The current relay sends fork host wakes directly to FCM. For hosts on the older publication protocol, it queues routing identifiers and rechecks the environment key, link, preferences, and token on delivery. The consumer discards older queued jobs containing activity details. Firebase `UNREGISTERED` responses invalidate the matching device token. The phone fetches the snapshot through Noise and applies its alert preferences locally.
