import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueTrackerKind } from "@t3tools/contracts";
import * as LinearDriver from "@t3tools/issue-tracker-linear/server/driver";
import { makeMepIssueTracker } from "@t3tools/source-control-meituan/server/driver";
import {
  isStandaloneIssueTracker,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as ServerSourceControlHost from "../sourceControl/ServerSourceControlHost.ts";
import * as IssueTrackerHostLive from "./IssueTrackerHostLive.ts";

export class IssueTrackerRegistry extends Context.Service<
  IssueTrackerRegistry,
  {
    /** Null for a kind with no implementation, which the service reports as unsupported. */
    readonly get: (kind: IssueTrackerKind) => IssueTrackerApi | null;
    readonly kinds: ReadonlyArray<IssueTrackerKind>;
    /** The trackers a user connects with a credential of their own, in registration order. */
    readonly standalone: ReadonlyArray<StandaloneIssueTrackerApi>;
  }
>()("t3/issue/IssueTrackerRegistry") {}

/** Exported for tests, which stand a registry up from trackers they supply themselves. */
export function fromTrackers(
  trackers: ReadonlyArray<IssueTrackerApi>,
): IssueTrackerRegistry["Service"] {
  const byKind = new Map(trackers.map((tracker) => [tracker.kind, tracker]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: trackers.map((tracker) => tracker.kind),
    standalone: trackers.filter(isStandaloneIssueTracker),
  };
}

const PROJECT_TRACKERS = [LinearDriver.make, makeMepIssueTracker] as const;

const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const projectTrackers = yield* Effect.all(PROJECT_TRACKERS);
  return fromTrackers([
    ...drivers.flatMap(({ instance }) => instance.issues ?? []),
    ...projectTrackers,
  ]);
});

export const layer = Layer.effect(IssueTrackerRegistry, make).pipe(
  Layer.provide(
    Layer.mergeAll(BuiltInDrivers.layer, IssueTrackerHostLive.layer, ServerSourceControlHost.layer),
  ),
);
