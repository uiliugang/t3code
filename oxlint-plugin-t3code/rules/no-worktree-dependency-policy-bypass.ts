import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";
import { getPropertyName } from "../utils.ts";

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Resolve worktree dependency mode on the destination server." },
    schema: [],
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (
      !/(?:^|\/)(?:apps|packages)\//.test(filename) ||
      filename.endsWith("/apps/server/src/workspace/worktreeDependencyEnvironment.ts") ||
      /\.(?:test|testkit)\.[cm]?[jt]sx?$/.test(filename)
    )
      return {};
    const message =
      "Leave dependency mode to the destination server. Server code must use worktreeDependencyEnvironment in apps/server/src/workspace/worktreeDependencyEnvironment.ts; clients must not set PNPM_CONFIG_VIRTUAL_STORE_TYPE.";
    return {
      MemberExpression(node) {
        if (
          Option.getOrUndefined(getPropertyName(node.property)) === "PNPM_CONFIG_VIRTUAL_STORE_TYPE"
        )
          context.report({ node, message });
      },
      Property(node) {
        if (Option.getOrUndefined(getPropertyName(node.key)) === "PNPM_CONFIG_VIRTUAL_STORE_TYPE")
          context.report({ node, message });
      },
    };
  },
});
