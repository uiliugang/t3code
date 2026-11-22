import { createSourceControlEnvironmentAtoms } from "@t3tools/client-runtime/state/source-control";

import { connectionAtomRuntime } from "../connection/runtime";

import { serverEnvironment } from "./server";

export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(
  connectionAtomRuntime,
  (environmentId) => serverEnvironment.settingsValueAtom(environmentId),
);
