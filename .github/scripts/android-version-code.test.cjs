const assert = require("node:assert/strict");
const test = require("node:test");
const { androidVersionCode } = require("./android-version-code.cjs");

test("release order follows semver, exceeds epoch-minute builds, and is stable across reruns", () => {
  const versions = ["0.1.9", "0.1.10", "0.1.999", "0.2.0", "0.999.999", "1.0.0", "1999.999.999"];
  let previous = 30_000_000;
  for (const version of versions) {
    const code = androidVersionCode(version);
    assert.ok(code > previous);
    assert.ok(code <= 2_100_000_000);
    assert.equal(code, androidVersionCode(version));
    previous = code;
  }
  for (const version of [
    "01.2.3",
    "1.2",
    "-1.2.3",
    "1.2.3-beta",
    "2000.0.0",
    "1.1000.0",
    "1.0.1000",
    "Infinity.0.0",
  ]) {
    assert.throws(() => androidVersionCode(version));
  }
});
