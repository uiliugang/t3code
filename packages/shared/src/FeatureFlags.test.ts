import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FeatureFlags from "./FeatureFlags.ts";
import * as HostProcess from "./HostProcess.ts";

it.effect("resolves T3CODE_FEATURE_FLAGS lists", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<
      readonly [string | undefined, Partial<FeatureFlags.FeatureFlagValues>]
    > = [
      [undefined, {}],
      [" tanstack_source , secret_providers=1 ", { tanstackSource: true, secretProviders: true }],
      [
        "tanstack_source=0,github_app_client_id=Iv23=x",
        { githubAppClientId: Option.some("Iv23=x") },
      ],
      ["tanstack_source,typo_flag", { tanstackSource: true }],
      // One bad value turns every flag off rather than failing startup.
      ["tanstack_source,secret_providers=maybe", {}],
    ];
    for (const [list, expected] of cases) {
      assert.deepStrictEqual(yield* FeatureFlags.resolve(list), {
        secretProviders: false,
        tanstackSource: false,
        githubAppClientId: Option.none(),
        ...expected,
      });
    }
  }),
);

it.effect("uses legacy settings only when the unified flag list is absent", () =>
  Effect.gen(function* () {
    const legacy = {
      T3CODE_FEATURE_SECRETS: " TRUE ",
      T3CODE_GITHUB_APP_CLIENT_ID: " Iv23=x ",
    };
    const load = (env: NodeJS.ProcessEnv) =>
      FeatureFlags.FeatureFlags.pipe(
        Effect.provide(FeatureFlags.layer),
        Effect.provideService(HostProcess.Environment, env),
      );
    assert.deepStrictEqual(yield* load(legacy), {
      secretProviders: true,
      tanstackSource: false,
      githubAppClientId: Option.some("Iv23=x"),
    });
    assert.deepStrictEqual(yield* load({ ...legacy, T3CODE_FEATURE_FLAGS: "" }), {
      secretProviders: false,
      tanstackSource: false,
      githubAppClientId: Option.none(),
    });
  }),
);
