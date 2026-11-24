import { describe, expect, it } from "vite-plus/test";

import {
  isLegalDocumentUrl,
  SECURITY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
} from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([TERMS_OF_SERVICE_URL, SECURITY_POLICY_URL])("allows retained document %s", (url) => {
    expect(isLegalDocumentUrl(`${url}#contact`)).toBe(true);
  });
  it.each([
    "https://example.com/legal",
    "javascript:alert(1)",
    "https://t3.codes/legal",
    "https://t3.codes/privacy-policy",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
