import * as Context from "effect/Context";
import type { HttpServerRequest } from "effect/http";
export const NoiseGuestCall = Context.Reference<boolean>("t3/auth/NoiseGuestCall", {
  defaultValue: () => false,
});
export interface NoiseGuestSession {
  readonly kind: "guest";
  readonly token: string;
  readonly shareId: string;
}
const sessions = new WeakMap<object, NoiseGuestSession>();
export function registerNoiseGuest(source: object, session: NoiseGuestSession) {
  sessions.set(source, session);
}
export function noiseGuestSession(request: HttpServerRequest.HttpServerRequest) {
  return typeof request.source === "object" && request.source !== null
    ? sessions.get(request.source)
    : undefined;
}
