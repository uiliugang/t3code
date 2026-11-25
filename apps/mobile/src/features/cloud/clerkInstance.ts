import { getClerkInstance } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { resolveCloudPublicConfig } from "./publicConfig";

const config = resolveCloudPublicConfig();
export const publishableKey = config.relay.url ? config.clerk.publishableKey : null;
// Headless Android tasks can start before ClerkProvider mounts.
export const cloudClerk = publishableKey ? getClerkInstance({ publishableKey, tokenCache }) : null;
