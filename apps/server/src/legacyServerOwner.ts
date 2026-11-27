// Effect-free so the service launcher shares the pre-lock owner identity check with server startup.

export const legacyOwnerStartTimeCommand = (
  pid: number,
  _platform: NodeJS.Platform,
  _hostEnv: NodeJS.ProcessEnv,
) => {
  return {
    command: "ps",
    args: ["-p", String(pid), "-o", "lstart="],
    env: { LC_ALL: "C", TZ: "UTC" },
  };
};

// ps reports whole seconds. Unknown identity (no output) stays conservative.
export const legacyOwnerStartedBeforeRecord = (
  output: string | undefined,
  recordedAt: number,
  _platform: NodeJS.Platform,
): boolean => {
  if (output === undefined) return true;
  const trimmed = output.trim();
  const startedAt = Date.parse(`${trimmed} UTC`);
  return !Number.isFinite(startedAt) || startedAt <= recordedAt + 1_000;
};
