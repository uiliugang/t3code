const assert = require("node:assert/strict");
const test = require("node:test");
const { androidVersionCode } = require("./android-version-code.cjs");

test("release order follows semver, exceeds epoch-minute builds, and is stable across reruns", () => {
  const versions = ["0.1.9", "0.1.10", "0.1.999", "0.2.0", "0.999.999", "1.0.0", "1998.999.999"];
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
    "1999.0.0",
    "1.1000.0",
    "1.0.1000",
    "Infinity.0.0",
  ]) {
    assert.throws(() => androidVersionCode(version));
  }
});

test("corrected fork releases upgrade the misnumbered 0.1.9 without changing its install identity", () => {
  assert.equal(androidVersionCode("0.1.9"), 100001009);
  assert.equal(androidVersionCode("0.0.18"), 100000018);
  const versions = ["0.0.19", "0.0.20", "0.0.999", "0.1.0", "0.1.8", "0.1.10", "1.0.0"];
  let previous = androidVersionCode("0.1.9");
  for (const version of versions) {
    const code = androidVersionCode(version);
    assert.ok(code > previous, `${version} must upgrade the preceding release`);
    assert.equal(code, androidVersionCode(version));
    previous = code;
  }
});
