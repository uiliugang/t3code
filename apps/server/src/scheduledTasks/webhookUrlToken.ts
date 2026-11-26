export const WITHHELD = "[withheld]";
const WEBHOOK_URL_TOKEN =
  /(t3hook:\/\/[^#\s"'<>`\\]+\/encrypted-v1#)[A-Za-z0-9%+_.*=&-]+|(\/(?:v1\/hooks\/[0-9a-f]{16}|api\/hooks)\/[^/\s"'\\]+\/)[A-Za-z0-9_-]+/g;

/**
 * Shows a webhook URL without its path token or encrypted credential fragment.
 * Matches the URL as the server prints it, not an escaped or split one.
 */
export const withoutWebhookUrlToken = (text: string) =>
  text.replace(WEBHOOK_URL_TOKEN, (_match, encrypted, plain) => `${encrypted ?? plain}${WITHHELD}`);
