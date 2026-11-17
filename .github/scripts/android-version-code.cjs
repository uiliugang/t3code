function androidVersionCode(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Android releases require a stable X.Y.Z version.");
  }
  const [major, minor, patch] = version.split(".").map(Number);
  if (major > 1998 || minor > 999 || patch > 999) {
    throw new Error("Android version components exceed the versionCode allocation.");
  }
  // Keep historical identities; the corrected sequence must upgrade the misnumbered 0.1.9 APK.
  const historical = version === "0.1.9" || (major === 0 && minor === 0 && patch <= 18);
  const base = historical ? 100_000_000 : 101_000_000;
  return base + major * 1_000_000 + minor * 1_000 + patch;
}

module.exports = { androidVersionCode };

if (require.main === module) console.log(androidVersionCode(process.argv[2] ?? ""));
