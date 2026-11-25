import * as Schema from "effect/Schema";
import {
  GuestRedeemRequest,
  GUEST_ATTACHMENT_ROUTE,
  GUEST_COMMAND_OUTPUT_ROUTE,
  GUEST_HISTORY_ROUTE,
  GUEST_ITEM_ROUTE,
  GUEST_MEDIA_ROUTE,
  GUEST_RENDER_ROUTE,
  GUEST_ROUTE_PREFIX,
} from "./guestShare.ts";

const shareId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const token = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048));
export const NoiseGuestRequest = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("guest-redeem"),
    credential: GuestRedeemRequest.fields.credential.check(Schema.isMaxLength(512)),
    name: GuestRedeemRequest.fields.name,
  }),
  Schema.Struct({ mode: Schema.Literal("guest-session"), token, shareId }),
]);
export type NoiseGuestRequest = typeof NoiseGuestRequest.Type;
export const NoiseGuestReply = Schema.Union([
  Schema.Struct({ status: Schema.Literal("guest-redeemed"), token, shareId }),
  Schema.Struct({ status: Schema.Literal("guest-ready") }),
  Schema.Struct({ status: Schema.Literal("rejected") }),
]);
export type NoiseGuestReply = typeof NoiseGuestReply.Type;

const reads = new Set([
  GUEST_ATTACHMENT_ROUTE,
  GUEST_COMMAND_OUTPUT_ROUTE,
  GUEST_HISTORY_ROUTE,
  GUEST_ITEM_ROUTE,
  GUEST_MEDIA_ROUTE,
  GUEST_RENDER_ROUTE,
  GUEST_ROUTE_PREFIX + "/session",
  GUEST_ROUTE_PREFIX + "/stream",
]);
export function isNoiseGuestRoute(method: string, path: string, share: string) {
  const url = URL.parse(path, "https://noise.invalid");
  if (
    !url ||
    url.origin !== "https://noise.invalid" ||
    path !== url.pathname + url.search ||
    url.searchParams.getAll("share").length !== 1 ||
    url.searchParams.get("share") !== share
  )
    return false;
  return method === "POST"
    ? url.pathname === GUEST_ROUTE_PREFIX + "/messages"
    : method === "GET" && reads.has(url.pathname);
}
