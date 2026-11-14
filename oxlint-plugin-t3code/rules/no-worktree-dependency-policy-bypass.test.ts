import { createOxlintRuleHarness } from "../test/utils.ts";

const client = createOxlintRuleHarness("t3code/no-worktree-dependency-policy-bypass", {
  filename: "packages/shared/src/projectScripts.ts",
});
client.invalid(
  "rejects the original client-side default that ignored project settings",
  `
  env.PNPM_CONFIG_VIRTUAL_STORE_TYPE = input.worktreeSharedDependencies === false ? "project" : "global";
`,
);
client.invalid(
  "rejects a computed environment override",
  'env["PNPM_CONFIG_VIRTUAL_STORE_TYPE"] = "global";',
);
client.valid(
  "leaves installation policy to the destination server",
  "env.T3CODE_WORKTREE_PATH = input.worktreePath;",
);

const server = createOxlintRuleHarness("t3code/no-worktree-dependency-policy-bypass", {
  filename: "apps/server/src/workspace/restoreMissingWorktree.ts",
});
server.invalid(
  "rejects the duplicated terminal-only policy",
  `
  const env = { PNPM_CONFIG_VIRTUAL_STORE_TYPE: settings.worktreeSharedDependencies ? "global" : "project" };
`,
);
server.valid(
  "uses the shared resolver",
  "const env = worktreeDependencyEnvironment(settings, thread.projectId);",
);

createOxlintRuleHarness("t3code/no-worktree-dependency-policy-bypass", {
  filename: "apps/server/src/workspace/worktreeDependencyEnvironment.ts",
}).valid("allows the policy owner", 'const env = { PNPM_CONFIG_VIRTUAL_STORE_TYPE: "project" };');
