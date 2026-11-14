import { createOxlintRuleHarness } from "../test/utils.ts";

const caller = createOxlintRuleHarness("t3code/no-runtime-cleanup-bypass", {
  filename: "apps/server/src/orchestration-v2/ThreadSettlementService.ts",
});
caller.invalid(
  "rejects the duplicated settlement cleanup from 58dc77fc1f",
  `
  ports.stopThreadServers(threadId, shouldCleanUp);
  terminals.closeOnSettle({ threadId, shouldClose: shouldCleanUp });
`,
);
caller.invalid("rejects extracting a retirement method", "const retire = devices.closeRetired;");
caller.valid(
  "uses the shared lifecycle owner",
  'cleanup.cleanupRuntime({ threadId, mode: "settled" });',
);
const owner = createOxlintRuleHarness("t3code/no-runtime-cleanup-bypass", {
  filename: "apps/server/src/orchestration-v2/ResourceCleanupService.ts",
});
owner.valid("allows the single owner", "ports.stopThreadServers(threadId, shouldRelease);");
