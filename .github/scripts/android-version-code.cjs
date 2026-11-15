function androidVersionCode(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Android releases require a stable X.Y.Z version.");
  }
  const [major, minor, patch] = version.split(".").map(Number);
  if (major > 1999 || minor > 999 || patch > 999) {
    throw new Error("Android version components exceed the versionCode allocation.");
  }
  // Reserve the old epoch-minute range; each stable version gets one reproducible install identity.
  return 100_000_000 + major * 1_000_000 + minor * 1_000 + patch;
}

module.exports = { androidVersionCode };

if (require.main === module) console.log(androidVersionCode(process.argv[2] ?? ""));
