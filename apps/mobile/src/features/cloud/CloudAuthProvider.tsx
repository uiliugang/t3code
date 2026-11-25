import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import type { ReactNode } from "react";

import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { cloudClerk, publishableKey } from "./clerkInstance";

if (cloudClerk) {
  cloudAccountService.attach(cloudClerk);
} else {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      {props.children}
    </ClerkProvider>
  );
}
