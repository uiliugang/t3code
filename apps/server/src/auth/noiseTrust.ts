import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Config from "effect/Config";
import * as Context from "effect/Context";

export const noiseOnly = Config.Boolean("T3CODE_NOISE_ONLY").pipe(Config.withDefault(false));
export const NoiseCaller = Context.Reference<boolean>("t3/auth/NoiseCaller", {
  defaultValue: () => false,
});

function directOrigin(input: string) {
  const url = URL.parse(input.trim());
  return url &&
    url.protocol === "https:" &&
    isPrivateNetworkHost(url.hostname) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
    ? url.origin
    : null;
}

export const guestOrigin = Config.String("T3CODE_NOISE_GUEST_ORIGIN").pipe(
  Config.withDefault(""),
  Config.map(directOrigin),
);
export const peerOrigins = Config.String("T3CODE_NOISE_PEER_ORIGINS").pipe(
  Config.withDefault(""),
  Config.map((value) =>
    value.trim() ? new Set(value.split(",").flatMap((entry) => directOrigin(entry) ?? [])) : null,
  ),
);

function httpsOrigin(input: string) {
  const url = URL.parse(input.trim());
  return url &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
    ? url.origin
    : null;
}
export const guestAppOrigin = Config.String("T3CODE_NOISE_GUEST_APP_ORIGIN").pipe(
  Config.withDefault(""),
  Config.map(httpsOrigin),
);
export const guestRelayOrigin = Config.String("T3CODE_NOISE_GUEST_RELAY_ORIGIN").pipe(
  Config.withDefault(""),
  Config.map(httpsOrigin),
);
