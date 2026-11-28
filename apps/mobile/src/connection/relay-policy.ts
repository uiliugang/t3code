import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export const relayPolicyChangedAtom = Atom.make<ReadonlyArray<EnvironmentId>>([]).pipe(
  Atom.keepAlive,
);
