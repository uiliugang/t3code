import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "./preferences";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime, (registry) => {
  const preferences = registry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) ? (preferences.value.uiLanguage ?? "en") : "en";
});
