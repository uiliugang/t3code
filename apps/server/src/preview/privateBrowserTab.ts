export const PRIVATE_BROWSER_THREAD_PREFIX = "private-browser:";

export const isPrivateBrowserThread = (threadId: string) =>
  threadId.startsWith(PRIVATE_BROWSER_THREAD_PREFIX);
