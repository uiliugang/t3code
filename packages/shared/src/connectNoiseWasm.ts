import initialize, { NoisePeer, host_public_key } from "./_generated/noise.js";
import binary from "./_generated/noise.json" with { type: "json" };

export { NoisePeer, host_public_key as noiseHostPublicKey };

let initializing: Promise<void> | undefined;
export function initializeConnectNoise() {
  return (initializing ??= initialize({
    module_or_path: Uint8Array.from(atob(binary), (value) => value.charCodeAt(0)),
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      initializing = undefined;
      throw error;
    }));
}

export function makeNoiseInitiator(environmentId: string, publicKey: Uint8Array) {
  const peer = NoisePeer.client(environmentId, publicKey);
  return {
    read: (value: Uint8Array) => peer.read(value),
    write: (value: Uint8Array) => peer.write(value),
    release: () => peer.free(),
  };
}
