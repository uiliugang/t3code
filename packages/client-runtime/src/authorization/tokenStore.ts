import { EnvironmentId } from "@t3tools/contracts";
import { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectionAttemptError } from "../connection/model.ts";

export class RemoteDpopAccessToken extends Schema.Class<
  RemoteDpopAccessToken,
  { readonly brand: unique symbol }
>("@t3tools/client-runtime/authorization/RemoteDpopAccessToken")({
  environmentId: EnvironmentId,
  accountId: Schema.optionalKey(Schema.String),
  label: Schema.String,
  endpoint: RelayManagedEndpoint,
  endpointNeedsDiscovery: Schema.optionalKey(Schema.Literal(true)),
  /** The stored endpoint authenticated this credential after its environment ID was checked. */
  endpointVerified: Schema.optionalKey(Schema.Literal(true)),
  accessToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  dpopThumbprint: Schema.String,
}) {}

export class RemoteDpopAccessTokenStore extends Context.Service<
  RemoteDpopAccessTokenStore,
  {
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<RemoteDpopAccessToken>, ConnectionAttemptError>;
    readonly put: (
      token: RemoteDpopAccessToken,
      ifCurrentAccessToken?: string | null,
    ) => Effect.Effect<void, ConnectionAttemptError>;
    readonly remove: (
      environmentId: EnvironmentId,
      ifCurrentAccessToken?: string,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/tokenStore/RemoteDpopAccessTokenStore") {}

export const make = (service: RemoteDpopAccessTokenStore["Service"]) =>
  RemoteDpopAccessTokenStore.of(service);
